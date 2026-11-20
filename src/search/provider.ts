import { setTimeout as sleep } from "node:timers/promises";
import type { SearchConfig } from "../config.js";
import { serializeWebRunPayload, type WebRunCommand } from "./commands.js";

export interface SearchResult {
  type?: string;
  ref_id?: string;
  url?: string;
  title?: string;
  snippet?: string;
  domain?: string;
}

export interface SearchResponse {
  output?: string;
  results: SearchResult[];
}

export interface WebSearchProvider {
  execute(
    command: WebRunCommand,
    signalOrOptions?: AbortSignal | { sessionId?: string },
    maybeSignal?: AbortSignal,
  ): Promise<SearchResponse>;
}

export class CodexWebSearchProvider implements WebSearchProvider {
  constructor(private readonly config: SearchConfig) {}

  async execute(
    command: WebRunCommand,
    signalOrOptions?: AbortSignal | { sessionId?: string },
    maybeSignal?: AbortSignal,
  ): Promise<SearchResponse> {
    const signal = signalOrOptions instanceof AbortSignal ? signalOrOptions : maybeSignal;
    const sessionId =
      (signalOrOptions instanceof AbortSignal ? undefined : signalOrOptions?.sessionId) ?? "search_default";

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`Search request timed out after ${this.config.timeoutMs}ms`)),
      this.config.timeoutMs,
    );
    const onExternalAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) throw signal.reason ?? new Error("Request cancelled");
      signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const payload = serializeWebRunPayload(command, {
      sessionId,
      model: this.config.model,
      live: this.config.live,
    });
    const headers = {
      Authorization: `Bearer ${this.config.token}`,
      "Content-Type": "application/json",
      Originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/1.0",
    };

    try {
      let response: Response | null = null;
      let lastErr: unknown;

      for (let attempt = 0; attempt <= 2; attempt++) {
        if (attempt > 0) {
          await sleep(500 * attempt, undefined, { signal: controller.signal });
        }
        try {
          response = await fetch(this.config.endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            redirect: "error",
            signal: controller.signal,
          });
          if (response.status === 502 || response.status === 503 || response.status === 504) {
            continue;
          }
          break;
        } catch (err) {
          lastErr = err;
          if (controller.signal.aborted) throw err;
        }
      }

      if (!response) {
        throw lastErr ?? new Error("No response received from search endpoint");
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`[HTTP ${response.status}] ${text.slice(0, 300)}`);
      }

      const body = (await response.json()) as Record<string, unknown>;
      const results: SearchResult[] = Array.isArray(body?.results) ? (body.results as SearchResult[]) : [];

      return {
        output: typeof body?.output === "string" ? body.output : undefined,
        results,
      };
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
  }
}
