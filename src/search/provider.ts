import { setTimeout as sleep } from "node:timers/promises";
import { redactToken, type SearchConfig } from "../config.js";
import { serializeWebRunPayload, type WebRunCommand } from "./commands.js";

export type SearchResult = {
  type?: string;
  ref_id?: string;
  url?: string;
  title?: string;
  snippet?: string;
  domain?: string;
};

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

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(3_000, Math.round(seconds * 1_000));
  }
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta >= 0) return Math.min(3_000, delta);
  }
  return undefined;
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
      if (signal.aborted) {
        clearTimeout(timeoutId);
        throw signal.reason ?? new Error("Request cancelled");
      }
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
      let retryDelayMs = 0;

      for (let attempt = 0; attempt <= 2; attempt++) {
        if (attempt > 0) {
          await sleep(retryDelayMs || 500 * attempt, undefined, { signal: controller.signal });
          retryDelayMs = 0;
        }
        try {
          response = await fetch(this.config.endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            redirect: "error",
            signal: controller.signal,
          });
          if (
            response.status === 429 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504
          ) {
            retryDelayMs = parseRetryAfterMs(response.headers.get("retry-after")) ?? 500 * (attempt + 1);
            continue;
          }
          break;
        } catch (err) {
          lastErr = err;
          if (controller.signal.aborted) throw err;
        }
      }

      if (!response) {
        const msg = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "No response received");
        throw new Error(redactToken(msg, this.config.token));
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(redactToken(`[HTTP ${response.status}] ${text.slice(0, 300)}`, this.config.token));
      }

      const body = (await response.json()) as Record<string, unknown>;
      const results: SearchResult[] = Array.isArray(body?.results) ? (body.results as SearchResult[]) : [];

      return {
        output: typeof body?.output === "string" ? body.output : undefined,
        results,
      };
    } catch (err) {
      if (err instanceof Error) {
        err.message = redactToken(err.message, this.config.token);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
  }
}
