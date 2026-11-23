import type { JsonValue } from "@earendil-works/pi-ai";
import { redactToken, type SearchConfig } from "../config.js";
import type { SearchCommands } from "./commands.js";

const OUTPUT_TOKENS = { short: 750, medium: 1_500, long: 3_000 };

export async function requestSearch(
  config: SearchConfig,
  id: string,
  commands: SearchCommands,
  signal?: AbortSignal,
): Promise<{ output: string; results: JsonValue[] }> {
  const responseLength = commands.response_length ?? "short";
  const timeout = AbortSignal.timeout(Math.trunc(config.timeoutMs));
  const response = await fetch(config.endpoint, {
    method: "POST",
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      Originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/1.0",
    },
    body: JSON.stringify({
      id,
      model: config.model,
      commands: { ...commands, response_length: responseLength },
      // A token cap can cut off the target line when the server starts its excerpt earlier.
      ...(commands.open?.some(({ lineno }) => lineno !== undefined)
        ? {}
        : { max_output_tokens: OUTPUT_TOKENS[responseLength] }),
      settings: { search_context_size: "low", external_web_access: config.live },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`[HTTP ${response.status}] ${redactToken(text, config.token).slice(0, 300)}`);
  }

  const body = (await response.json()) as { output?: JsonValue; results?: JsonValue } | null;
  if (typeof body?.output !== "string") throw new Error("Codex search response has no text output.");
  return { output: body.output, results: Array.isArray(body.results) ? body.results : [] };
}
