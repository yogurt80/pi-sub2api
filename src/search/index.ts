import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { redactToken, type SearchConfig } from "../config.js";
import { CodexWebSearchProvider, type SearchResult, type WebSearchProvider } from "./provider.js";
import {
  BrowseToolParameters,
  ResearchToolOutputSchema,
  SearchToolParameters,
  browseParamsToWebRunCommand,
  searchParamsToWebRunCommand,
  type BrowseToolParams,
  type SearchToolParams,
  type WebRunCommand,
} from "./commands.js";
import {
  describeCommandStatus,
  formatWebToolResult,
  makeWebToolCallRenderer,
  makeWebToolRenderer,
  type FormattedToolOutput,
} from "./render.js";

const VIEW_REF_PATTERN = /^turn\d+view\d+$/i;

function normalizeUrlForMatch(raw: string): string {
  return raw.trim().toLowerCase().replace(/\/+$/, "");
}

function isViewRef(refId: unknown): refId is string {
  return typeof refId === "string" && VIEW_REF_PATTERN.test(refId.trim());
}

/**
 * Resolves a previously opened page's `turnXviewY` reference from session tool
 * history. Only matches view refs (never `turnXsearchY`) and prefers exact URL
 * matches before falling back to prefix/substring matches.
 */
export function resolveViewRefFromSession(
  sessionManager: { getBranch?: () => Array<unknown> } | undefined,
  targetUrl: string,
): string | undefined {
  if (!sessionManager || typeof sessionManager.getBranch !== "function") return undefined;
  try {
    const branch = sessionManager.getBranch();
    if (!Array.isArray(branch)) return undefined;
    const normalizedTarget = normalizeUrlForMatch(targetUrl);
    if (!normalizedTarget) return undefined;

    let fuzzyFallback: string | undefined;

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as Record<string, unknown> | null;
      if (!entry || entry.type !== "message") continue;
      const message = entry.message as Record<string, unknown> | null;
      if (!message || message.role !== "toolResult") continue;

      const details = (message.details as Record<string, unknown>) || {};
      const command = (details.command as WebRunCommand | undefined) ?? undefined;
      const results: SearchResult[] = Array.isArray(details.results) ? (details.results as SearchResult[]) : [];

      const isBrowseResult = Boolean(command?.open?.length || command?.click?.length || command?.find?.length);

      for (const r of results) {
        if (!isViewRef(r.ref_id)) continue;
        if (!r.url) continue;
        const rUrl = normalizeUrlForMatch(r.url);
        if (rUrl === normalizedTarget) return r.ref_id;
        if (
          !fuzzyFallback &&
          isBrowseResult &&
          (rUrl.startsWith(`${normalizedTarget}/`) || normalizedTarget.startsWith(`${rUrl}/`))
        ) {
          fuzzyFallback = r.ref_id;
        }
      }

      const openRef = command?.open?.[0]?.ref_id;
      if (typeof openRef === "string" && normalizeUrlForMatch(openRef) === normalizedTarget) {
        const firstView = results.find((r) => isViewRef(r.ref_id));
        if (firstView?.ref_id) return firstView.ref_id;
      }
    }

    return fuzzyFallback;
  } catch {
    // Ignore malformed session history
  }
  return undefined;
}

function makeErrorResult(message: string): FormattedToolOutput {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { results: [] },
    details: { error: message },
    isError: true,
  };
}

async function executeResearch(
  provider: WebSearchProvider,
  params: WebRunCommand,
  signal: AbortSignal | undefined,
  onUpdate:
    | ((update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void)
    | undefined,
  ctx?: ExtensionContext,
  tokenToRedact?: string,
): Promise<FormattedToolOutput> {
  const hasDocAction = Boolean(params.open?.length || params.find?.length || params.click?.length);
  const command: WebRunCommand = {
    ...params,
    response_length: params.response_length ?? (hasDocAction ? "long" : "short"),
  };

  if (typeof onUpdate === "function") {
    const statusMsg = describeCommandStatus(command);
    onUpdate({
      content: [{ type: "text", text: statusMsg }],
      details: { status: statusMsg, command },
    });
  }

  const rawSessionId = ctx?.sessionManager?.getSessionId?.();
  const sessionId = rawSessionId
    ? `search_${rawSessionId}`
    : `search_${Math.random().toString(36).substring(2, 10)}`;

  try {
    const response = await provider.execute(command, { sessionId }, signal);
    return formatWebToolResult(command, response);
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    return makeErrorResult(redactToken(rawMsg, tokenToRedact));
  }
}

function createSearchTool(provider: WebSearchProvider, token: string): ToolDefinition<typeof SearchToolParameters> {
  return {
    name: "codex-search",
    label: "Codex Web Search",
    description:
      "Search the web or images using OpenAI Codex search engine via Sub2API. Supports 'web' (default) and 'image' search with optional recency and domain filters.",
    promptSnippet: "Search the web or images with recency and domain filters",
    promptGuidelines: [
      "Use codex-search to find up-to-date documentation, APIs, or web sources, then use codex-browse to read full pages.",
    ],
    parameters: SearchToolParameters,
    outputSchema: ResearchToolOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const command = searchParamsToWebRunCommand(params as SearchToolParams);
      return executeResearch(provider, command, signal, onUpdate, ctx, token);
    },
    renderCall: makeWebToolCallRenderer("codex-search"),
    renderResult: makeWebToolRenderer("codex-search"),
  };
}

function createBrowseTool(provider: WebSearchProvider, token: string): ToolDefinition<typeof BrowseToolParameters> {
  return {
    name: "codex-browse",
    label: "Codex Web Browser",
    description:
      "Inspect and read full web page content by URL, find text within a previously opened page (pattern), or click numbered links (click_id).",
    promptSnippet: "Read web pages by URL, search inside an opened page, or follow numbered links",
    parameters: BrowseToolParameters,
    outputSchema: ResearchToolOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const browseParams = params as BrowseToolParams;
      const trimmedUrl = browseParams.url?.trim() || "";
      const isDirectTurnRef = VIEW_REF_PATTERN.test(trimmedUrl);

      if (typeof browseParams.click_id === "number") {
        const refId = isDirectTurnRef ? trimmedUrl : resolveViewRefFromSession(ctx?.sessionManager, trimmedUrl);
        if (!refId) {
          return makeErrorResult(
            `Page "${browseParams.url}" has not been opened in this session yet. Open it first with codex-browse before clicking link #${browseParams.click_id}.`,
          );
        }
        return executeResearch(provider, browseParamsToWebRunCommand(browseParams, refId), signal, onUpdate, ctx, token);
      }

      if (typeof browseParams.pattern === "string" && browseParams.pattern.trim()) {
        const refId = isDirectTurnRef ? trimmedUrl : resolveViewRefFromSession(ctx?.sessionManager, trimmedUrl);
        if (!refId) {
          return makeErrorResult(
            `Page "${browseParams.url}" has not been opened in this session yet. Open it first with codex-browse before searching for "${browseParams.pattern.trim()}".`,
          );
        }
        return executeResearch(provider, browseParamsToWebRunCommand(browseParams, refId), signal, onUpdate, ctx, token);
      }

      return executeResearch(provider, browseParamsToWebRunCommand(browseParams), signal, onUpdate, ctx, token);
    },
    renderCall: makeWebToolCallRenderer("codex-browse"),
    renderResult: makeWebToolRenderer("codex-browse"),
  };
}

export function registerSub2ApiSearch(pi: ExtensionAPI, config: SearchConfig): void {
  if (!config.enabled) return;
  const provider = new CodexWebSearchProvider(config);
  pi.registerTool(createSearchTool(provider, config.token));
  pi.registerTool(createBrowseTool(provider, config.token));
}
