import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "@sinclair/typebox";
import { redactToken, type SearchConfig } from "../config.js";
import { BrowseToolParameters, SearchOutputSchema, SearchToolParameters, type SearchCommands } from "./commands.js";
import { requestSearch } from "./provider.js";

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {}, isError: true };
}

export function registerSub2ApiSearch(pi: ExtensionAPI, config: SearchConfig): void {
  if (!config.enabled) return;

  async function execute(commands: SearchCommands, sessionId: string, signal?: AbortSignal) {
    try {
      const { output, results } = await requestSearch(config, `search_${sessionId}`, commands, signal);
      if (commands.click && output.startsWith("Internal Error ()") && output.includes("Unable to resolve click call")) {
        return errorResult("Could not resolve the page reference or link ID. Open the page again and use a link ID from the new result.");
      }

      const text = output.replace(/\uE200cite\uE202([^\uE201]+)\uE201/g, "[$1]").trim();
      return {
        content: [{ type: "text" as const, text: text || "No text returned by Codex search." }],
        structuredContent: { output, results },
        details: {},
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(redactToken(message, config.token));
    }
  }

  pi.registerTool({
    name: "codex-search",
    label: "Codex Web Search",
    description: "Search the web or images via Codex with one query. Search once first and follow up only if the results leave a specific gap.",
    parameters: SearchToolParameters,
    outputSchema: SearchOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
    executionMode: "parallel",
    async execute(_id, { q, domains, recency, type }: Static<typeof SearchToolParameters>, signal, _onUpdate, ctx) {
      const text = q.trim();
      if (!text) return errorResult("Provide a non-empty query.");

      const query = { q: text, domains, recency };
      const commands = type === "image" ? { image_query: [query] } : { search_query: [query] };
      return execute(commands, ctx.sessionManager.getSessionId(), signal);
    },
  });

  pi.registerTool({
    name: "codex-browse",
    label: "Codex Web Browser",
    description: "Read page excerpts, find text by URL, or follow numbered links from a Codex page reference.",
    parameters: BrowseToolParameters,
    outputSchema: SearchOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
    executionMode: "parallel",
    async execute(_id, { url, click_id, pattern, lineno, response_length }: Static<typeof BrowseToolParameters>, signal, _onUpdate, ctx) {
      const ref_id = url.trim();
      const text = pattern?.trim();
      if (!ref_id) return errorResult("Provide a URL or page reference.");
      if (click_id !== undefined && URL.canParse(ref_id)) {
        return errorResult("To follow a numbered link, use the page reference from the result that showed it.");
      }
      if ([click_id, pattern, lineno].filter((value) => value !== undefined).length > 1) {
        return errorResult("Use only one of click_id, pattern, or lineno.");
      }
      if (pattern !== undefined && !text) return errorResult("Provide a non-empty pattern.");

      let commands: SearchCommands;
      if (click_id !== undefined) commands = { click: [{ ref_id, id: click_id }] };
      else if (text) commands = { find: [{ ref_id, pattern: text }] };
      else commands = { open: [{ ref_id, lineno }] };
      return execute({ ...commands, response_length }, ctx.sessionManager.getSessionId(), signal);
    },
  });
}
