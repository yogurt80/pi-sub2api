import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { redactToken, type SearchConfig } from "../config.js";
import { commandsSchema, type SearchCommands } from "./commands.js";
import { recentInput } from "./history.js";
import { requestSearch } from "./provider.js";

const TOOL_NAME = "codex-web";
// Models advertising literature_search_query in the pinned Codex model catalog.
const LITERATURE_MODELS = new Set(["gpt-6.2-sol", "gpt-6.2-astra"]);

function errorMessage(message: string, token: string): string {
  const text = redactToken(message, token);
  if (Buffer.byteLength(text) <= 1024) return text;
  const suffix = "… [truncated]";
  const bytes = Buffer.from(text);
  let end = 1024 - Buffer.byteLength(suffix);
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return bytes.toString("utf8", 0, end) + suffix;
}

export function registerSub2ApiSearch(pi: ExtensionAPI, config: SearchConfig): void {
  if (!config.enabled) return;
  const supportsLiterature = LITERATURE_MODELS.has(config.model);
  const description = readFileSync(new URL("./description.md", import.meta.url), "utf8").trim();
  pi.registerTool({
    name: TOOL_NAME,
    label: "Codex Web",
    description,
    parameters: commandsSchema(supportsLiterature),
    executionMode: "parallel",
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(_id, commands: SearchCommands, signal, _onUpdate, ctx) {
      try {
        if (!supportsLiterature && "literature_search_query" in commands) {
          throw new Error("literature_search_query is unavailable for this model");
        }
        const input = config.includeRecentInput ? recentInput(ctx.sessionManager.buildSessionProjection().messages) : undefined;
        const { output, results } = await requestSearch(config, ctx.sessionManager.getSessionId(), commands, input, signal);
        return { content: [{ type: "text", text: output }], details: { results } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: errorMessage(message, config.token) }], details: {}, isError: true };
      }
    },
  });
}
