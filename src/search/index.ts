import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SearchConfig } from "../config.js";
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

function resolveViewRefFromSession(
  sessionManager: { getBranch?: () => Array<unknown> } | undefined,
  targetUrl: string,
): string | undefined {
  if (!sessionManager || typeof sessionManager.getBranch !== "function") return undefined;
  try {
    const branch = sessionManager.getBranch();
    if (!Array.isArray(branch)) return undefined;
    const normalizedTarget = targetUrl.trim().toLowerCase();

    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i] as Record<string, unknown> | null;
      if (!entry || entry.type !== "message") continue;
      const message = entry.message as Record<string, unknown> | null;
      if (!message || message.role !== "toolResult") continue;

      const details = (message.details as Record<string, unknown>) || {};
      const results: SearchResult[] = (details.results as SearchResult[]) || [];
      const match = results.find((r) => {
        if (!r.url) return false;
        const rUrl = r.url.toLowerCase();
        return rUrl === normalizedTarget || rUrl.includes(normalizedTarget) || normalizedTarget.includes(rUrl);
      });
      if (match?.ref_id) return match.ref_id;

      const openRef = (details.command as any)?.open?.[0]?.ref_id;
      if (typeof openRef === "string" && openRef.toLowerCase() === normalizedTarget) {
        if (results[0]?.ref_id) return results[0].ref_id;
      }
    }
  } catch {
    // Ignore malformed session history
  }
  return undefined;
}

async function executeResearch(
  provider: WebSearchProvider,
  params: WebRunCommand,
  signal: AbortSignal | undefined,
  onUpdate:
    | ((update: { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }) => void)
    | undefined,
  ctx?: ExtensionContext,
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
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: errorMsg }],
      structuredContent: { output: undefined, results: [] },
      details: { error: errorMsg },
      isError: true,
    };
  }
}

function createSearchTool(provider: WebSearchProvider): ToolDefinition {
  return {
    name: "codex-search",
    label: "Codex Web Search",
    description:
      "Search the web or visual assets using OpenAI Codex search engine. Supports search types: 'web' (default) and 'image'.",
    parameters: SearchToolParameters,
    ...({
      outputSchema: ResearchToolOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    } as any),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const command = searchParamsToWebRunCommand(params as SearchToolParams);
      return executeResearch(provider, command, signal, onUpdate, ctx);
    },
    renderCall: makeWebToolCallRenderer("codex-search"),
    renderResult: makeWebToolRenderer("codex-search"),
  };
}

function createBrowseTool(provider: WebSearchProvider): ToolDefinition {
  return {
    name: "codex-browse",
    label: "Codex Web Browser",
    description:
      "Inspect and read full web page content by URL, or click numbered links within a previously read page by providing its url and click_id.",
    parameters: BrowseToolParameters,
    ...({
      outputSchema: ResearchToolOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    } as any),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const browseParams = params as BrowseToolParams;
      const trimmedUrl = browseParams.url?.trim() || "";

      if (typeof browseParams.click_id === "number") {
        const isDirectTurnRef = /^turn\d+view\d+$/i.test(trimmedUrl);
        const refId = isDirectTurnRef ? trimmedUrl : resolveViewRefFromSession(ctx?.sessionManager, trimmedUrl);
        if (!refId) {
          throw new Error(
            `Page "${browseParams.url}" has not been opened in this session yet. Open it first with codex-browse before clicking link #${browseParams.click_id}.`,
          );
        }
        return executeResearch(provider, browseParamsToWebRunCommand(browseParams, refId), signal, onUpdate, ctx);
      }

      return executeResearch(provider, browseParamsToWebRunCommand(browseParams), signal, onUpdate, ctx);
    },
    renderCall: makeWebToolCallRenderer("codex-browse"),
    renderResult: makeWebToolRenderer("codex-browse"),
  };
}

export function registerSub2ApiSearch(pi: ExtensionAPI, config: SearchConfig): void {
  if (!config.enabled) return;
  const provider = new CodexWebSearchProvider(config);
  pi.registerTool(createSearchTool(provider));
  pi.registerTool(createBrowseTool(provider));
}
