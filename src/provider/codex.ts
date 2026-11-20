import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { asObject } from "../config.js";
import {
  lookupMetadata,
  parseInputModalities,
  parseSupportedEfforts,
  positiveInt,
  type ChatModel,
  type ManifestEntry,
  type MetadataIndex,
} from "./catalog.js";

const CODEX_MODEL_PATTERN = /^(?:chatgpt|codex|gpt|o\d)(?:-|$)/i;
const CODEX_EXCLUDED = /^(?:gpt-image|gpt-oss-|codex-auto-review$)/i;
const DEFAULT_CONTEXT_WINDOW = 272_000;
const DEFAULT_MAX_TOKENS = 128_000;

export function isCodexModel(id: string, antigravityIds: ReadonlySet<string>): boolean {
  if (antigravityIds.has(id) || CODEX_EXCLUDED.test(id)) return false;
  return CODEX_MODEL_PATTERN.test(id);
}

export async function fetchCodexManifest(root: string, token: string): Promise<ManifestEntry[]> {
  const response = await fetch(`${root}/backend-api/codex/models`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Codex manifest fetch failed (HTTP ${response.status})`);
  }
  const payload = asObject(await response.json().catch(() => undefined));
  if (!Array.isArray(payload?.models)) {
    throw new Error("Codex manifest returned an invalid payload");
  }
  const entries: ManifestEntry[] = [];
  for (const raw of payload.models) {
    const obj = asObject(raw);
    if (!obj || typeof obj.slug !== "string" || !obj.slug.trim()) continue;
    entries.push({
      slug: obj.slug.trim(),
      display_name: typeof obj.display_name === "string" ? obj.display_name : undefined,
      description: typeof obj.description === "string" ? obj.description : undefined,
      comp_hash: typeof obj.comp_hash === "string" ? obj.comp_hash : undefined,
      context_window: positiveInt(obj.context_window),
      max_context_window: positiveInt(obj.max_context_window),
      max_output_tokens: positiveInt(obj.max_output_tokens),
      max_tokens: positiveInt(obj.max_tokens),
      input_modalities: obj.input_modalities,
      supported_reasoning_levels: obj.supported_reasoning_levels,
      default_reasoning_level:
        typeof obj.default_reasoning_level === "string" ? obj.default_reasoning_level : undefined,
      reasoning: typeof obj.reasoning === "boolean" ? obj.reasoning : undefined,
    });
  }
  return entries;
}

function buildCodexThinkingMap(efforts: string[] | undefined): ChatModel["thinkingLevelMap"] {
  if (!efforts || efforts.length === 0) {
    return { off: "none", minimal: "low", xhigh: "xhigh" };
  }
  const set = new Set(efforts);
  return {
    off: "none",
    minimal: set.has("low") ? "low" : null,
    low: set.has("low") ? "low" : null,
    medium: set.has("medium") ? "medium" : null,
    high: set.has("high") ? "high" : null,
    xhigh: set.has("xhigh") ? "xhigh" : null,
    max: set.has("max") ? "max" : set.has("ultra") ? "ultra" : null,
  };
}

export function buildCodexModel(
  id: string,
  manifest: ManifestEntry | undefined,
  official: MetadataIndex,
  apiBase: string,
): ChatModel {
  const candidates = id.toLowerCase() === "gpt-5.6" ? [id, "gpt-5.6-sol"] : [id];
  const codexMeta = lookupMetadata(official, ["openai-codex"], candidates);
  const openaiMeta = lookupMetadata(official, ["openai"], candidates);
  const meta = codexMeta ?? openaiMeta;

  // Upstream Codex manifest entries carry `comp_hash` (authoritative channel limits).
  // For Sub2API-synthesized entries without `comp_hash`, prefer Pi's openai-codex catalog
  // (e.g. gpt-6-astra is 272k on Codex vs 1.05M on API), then fall back to manifest.
  const hasUpstreamManifest = Boolean(manifest?.comp_hash);
  const contextWindow =
    (hasUpstreamManifest
      ? positiveInt(manifest?.context_window, codexMeta?.contextWindow, openaiMeta?.contextWindow)
      : positiveInt(codexMeta?.contextWindow, manifest?.context_window, openaiMeta?.contextWindow)) ??
    DEFAULT_CONTEXT_WINDOW;

  const maxTokens = Math.min(
    contextWindow,
    positiveInt(manifest?.max_output_tokens, manifest?.max_tokens, meta?.maxTokens) ??
      DEFAULT_MAX_TOKENS,
  );

  const efforts = parseSupportedEfforts(manifest?.supported_reasoning_levels);
  const reasoning =
    efforts !== undefined
      ? efforts.length > 0
      : meta?.reasoning ?? /^(?:codex-|gpt-[56]|o\d)/i.test(id);

  const input = parseInputModalities(manifest?.input_modalities) ?? meta?.input ?? ["text", "image"];

  return {
    id,
    name: manifest?.display_name || id,
    api: "openai-codex-responses",
    baseUrl: apiBase,
    reasoning,
    input,
    cost: meta?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    thinkingLevelMap: reasoning ? buildCodexThinkingMap(efforts) : undefined,
  };
}

/**
 * Reuses Pi's official OpenAI Codex Responses adapter and rewrites the target
 * URL from `<apiBase>/codex/responses` to Sub2API's `<apiBase>/responses`.
 */
export function createCodexStreamSimple(
  apiBase: string,
  token: string,
): NonNullable<ProviderConfig["streamSimple"]> {
  const adapter = openAICodexResponsesApi();
  // Adapter requires a ChatGPT account claim JWT; this local placeholder is never sent upstream.
  const account = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "sub2api" } }),
  ).toString("base64url");
  const placeholder = `eyJhbGciOiJub25lIn0.${account}.local`;

  return (model, context, options) =>
    adapter.streamSimple(model, context, {
      ...options,
      apiKey: placeholder,
      transport: "sse",
      fetch: (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url !== `${apiBase}/codex/responses`) {
          throw new Error("Unexpected Sub2API Codex endpoint");
        }
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        headers.set("Authorization", `Bearer ${options?.apiKey ?? token}`);
        headers.delete("chatgpt-account-id");
        const upstreamFetch = options?.fetch ?? fetch;
        return upstreamFetch(`${apiBase}/responses`, { ...init, headers, redirect: "error" });
      },
    });
}
