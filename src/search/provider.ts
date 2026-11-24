import type { JsonValue } from "@earendil-works/pi-ai";
import { redactToken, type SearchConfig } from "../config.js";
import type { SearchCommands } from "./commands.js";
import type { recentInput } from "./history.js";

const MAX_OUTPUT_TOKENS = 10_000;

export async function requestSearch(
  config: SearchConfig,
  id: string,
  commands: SearchCommands,
  input: ReturnType<typeof recentInput>,
  signal?: AbortSignal,
): Promise<{ output: string; results: JsonValue[] }> {
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
      input,
      commands,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      settings: { external_web_access: config.live, allowed_callers: ["direct"] },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`[HTTP ${response.status}] ${redactToken(text, config.token)}`);
  }

  const body = (await response.json()) as { output?: JsonValue; results?: JsonValue } | null;
  if (typeof body?.output !== "string") throw new Error("Codex search response has no text output.");
  return { output: body.output, results: Array.isArray(body.results) ? body.results : [] };
}
