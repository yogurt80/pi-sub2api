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
import { formatWebToolResult, makeWebToolError, type FormattedToolOutput } from "./output.js";
import { describeCommandStatus, makeWebToolCallRenderer, makeWebToolRenderer } from "./render.js";

const VIEW_REF_PATTERN = /^turn\d+view\d+$/i;

function normalizePageUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw.trim());
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    // Session history can also contain document references and malformed URLs.
  }
  return undefined;
}

function isViewRef(refId: unknown): refId is string {
  return typeof refId === "string" && VIEW_REF_PATTERN.test(refId.trim());
}

/**
 * Resolve the latest exact URL match, including the original URL of an open or
 * find that returned a redirect. Numbered links belong to a specific view.
 */
export function resolveViewRefFromSession(
  sessionManager: { getBranch?: () => Array<unknown> } | undefined,
  targetUrl: string,
): string | undefined {
  if (!sessionManager || typeof sessionManager.getBranch !== "function") return undefined;
  try {
    const branch = sessionManager.getBranch();
    if (!Array.isArray(branch)) return undefined;
    const normalizedTarget = normalizePageUrl(targetUrl);
    if (!normalizedTarget) return undefined;

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as Record<string, unknown> | null;
      if (!entry || entry.type !== "message") continue;
      const message = entry.message as Record<string, unknown> | null;
      if (message?.role !== "toolResult" || message.toolName !== "codex-browse" || message.isError) continue;

      const details = message.details as { command?: WebRunCommand; results?: Array<SearchResult | null> } | undefined;
      if (!Array.isArray(details?.results)) continue;
      const views = details.results.filter((result) => isViewRef(result?.ref_id) && normalizePageUrl(result?.url));
      const match = views.find((result) => normalizePageUrl(result?.url) === normalizedTarget);
      if (match?.ref_id) return match.ref_id.trim();

      const originalUrl = details.command?.open?.[0]?.ref_id ?? details.command?.find?.[0]?.ref_id;
      if (views.length === 1 && normalizePageUrl(originalUrl) === normalizedTarget) {
        return views[0]?.ref_id?.trim();
      }
    }
  } catch {
    // Ignore malformed session history.
  }
  return undefined;
}

async function executeResearch(
  provider: WebSearchProvider,
  command: WebRunCommand,
  signal: AbortSignal | undefined,
  onUpdate:
    | ((update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void)
    | undefined,
  ctx?: ExtensionContext,
  tokenToRedact?: string,
): Promise<FormattedToolOutput> {
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
    return makeWebToolError(redactToken(rawMsg, tokenToRedact));
  }
}

function createSearchTool(provider: WebSearchProvider, token: string): ToolDefinition<typeof SearchToolParameters> {
  return {
    name: "codex-search",
    label: "Codex Web Search",
    description:
      "Search the web or images using OpenAI Codex search engine via Sub2API. Supports domain filters for both modes and recency for web search.",
    promptSnippet: "Search the web or images with domain filters and optional web recency",
    promptGuidelines: [
      "Use codex-search to find up-to-date documentation, APIs, or web sources, then use codex-browse to read relevant sections.",
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
      "Read a page excerpt or find text by URL or page reference. Follow numbered links using the page reference from the result that showed the link.",
    promptSnippet: "Read page excerpts, find text by URL, or follow numbered links",
    promptGuidelines: [
      "When clicking a numbered link, pass the turn…view… reference from the exact result that showed that link.",
    ],
    parameters: BrowseToolParameters,
    outputSchema: ResearchToolOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const browseParams = params as BrowseToolParams;
      let refId: string | undefined;
      if (typeof browseParams.click_id === "number") {
        const target = browseParams.url.trim();
        refId = isViewRef(target) ? target : resolveViewRefFromSession(ctx?.sessionManager, target);
        if (!refId) {
          return makeWebToolError(
            `Open the page before clicking link #${browseParams.click_id}, or use the page reference from the result that showed the link.`,
          );
        }
      }
      const command = browseParamsToWebRunCommand(browseParams, refId);
      return executeResearch(provider, command, signal, onUpdate, ctx, token);
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
