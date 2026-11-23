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
  image_url?: string;
};

const RESULT_FIELDS = ["type", "ref_id", "url", "title", "snippet", "domain", "image_url"] as const;

function parseSearchResults(value: unknown): SearchResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const entry = item as Record<string, unknown>;
    const result: SearchResult = {};
    for (const key of RESULT_FIELDS) {
      const field = entry[key];
      if (typeof field === "string" && field.trim()) result[key] = field;
    }
    return Object.keys(result).length ? [result] : [];
  });
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
      const body = JSON.stringify(payload);
      let retryDelayMs = 0;
      for (let attempt = 1; ; attempt++) {
        if (retryDelayMs > 0) await sleep(retryDelayMs, undefined, { signal: controller.signal });

        let response: Response;
        try {
          response = await fetch(this.config.endpoint, {
            method: "POST",
            headers,
            body,
            redirect: "error",
            signal: controller.signal,
          });
        } catch (err) {
          if (controller.signal.aborted || attempt === 3) throw err;
          retryDelayMs = 500 * attempt;
          continue;
        }

        if (attempt < 3 && [429, 502, 503, 504].includes(response.status)) {
          retryDelayMs = parseRetryAfterMs(response.headers.get("retry-after")) ?? 500 * attempt;
          await response.body?.cancel().catch(() => {});
          continue;
        }
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`[HTTP ${response.status}] ${redactToken(text, this.config.token).slice(0, 300)}`);
        }

        const result = (await response.json()) as Record<string, unknown> | null;
        return {
          output: typeof result?.output === "string" ? result.output : undefined,
          results: parseSearchResults(result?.results),
        };
      }
    } catch (err) {
      const reason = controller.signal.aborted ? controller.signal.reason : err;
      const message = reason instanceof Error ? reason.message : String(reason);
      throw new Error(redactToken(message, this.config.token));
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
  }
}
