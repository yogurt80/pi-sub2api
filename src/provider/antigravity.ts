import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionVirtualModel } from "@earendil-works/pi-coding-agent";
import { asObject } from "../config.js";
import {
  lookupMetadata,
  parseInputModalities,
  parseSupportedEfforts,
  positiveInt,
  type ChatModel,
  type ManifestEntry,
  type MetadataIndex,
  type Sub2ApiApi,
} from "./catalog.js";

const CLAUDE_PATTERN = /^claude-/i;
const GEMINI_PATTERN = /^gemini-/i;
const ANTIGRAVITY_EXCLUDED = /^(?:tab_|chat_|.*-image(?:-|$))/i;

/**
 * Effort suffixes used by Antigravity variant IDs (e.g. gemini-4-neon-xhigh,
 * claude-opus-5-5-high, gemini-4-hydrogen-tiered-xhigh, gemini-4-carbon-disabled).
 * Note: `*-tiered-{high,xhigh}` folds into its own `*-tiered` virtual group,
 * separate from the non-tiered family, while `*-sonar` stays standalone.
 */
const FOLDABLE_SUFFIX = /^(.*?)-(low|medium|high|xhigh|disabled)$/i;
const METADATA_STRIP_SUFFIX = /-(?:tiered-)?(?:xhigh|high|medium|low|minimal|disabled|thinking|sonar|tiered)$/i;

const LEVEL_ORDER: readonly ModelThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];
const FULL_LEVEL_ORDER: readonly ModelThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const RATE_LIMIT_ERROR_PATTERN = /\b(?:429|529|rate[_\s-]?limit|too many requests|overload(?:ed)?|quota|capacity)\b/i;

export async function fetchAntigravityIds(
  root: string,
  token: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const timeout = AbortSignal.timeout(10_000);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(`${root}/antigravity/v1/models`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: combinedSignal,
    });
    if (!response.ok) return [];
    const payload = asObject(await response.json().catch(() => undefined));
    if (!Array.isArray(payload?.data)) return [];
    const ids: string[] = [];
    for (const item of payload.data) {
      const id = asObject(item)?.id;
      if (typeof id === "string" && id.trim()) ids.push(id.trim());
    }
    return ids;
  } catch {
    return [];
  }
}

export function isAntigravityExcluded(id: string): boolean {
  return ANTIGRAVITY_EXCLUDED.test(id);
}

/**
 * Sub2API fills unknown/unbacked Antigravity entries in /backend-api/codex/models
 * with a synthetic placeholder: 272k context, text-only, no reasoning levels, no comp_hash.
 */
export function isManifestPlaceholder(entry: ManifestEntry | undefined): boolean {
  if (!entry || entry.comp_hash) return false;
  const parsed = parseSupportedEfforts(entry.supported_reasoning_levels);
  const inputs = parseInputModalities(entry.input_modalities);
  return (
    entry.context_window === 272_000 &&
    (!parsed || parsed.efforts.length === 0) &&
    inputs?.length === 1 &&
    inputs[0] === "text"
  );
}

function stripVariantSuffix(id: string): string {
  return id.replace(METADATA_STRIP_SUFFIX, "");
}

function defaultMaxTokensForFamily(id: string, official: MetadataIndex): number {
  if (CLAUDE_PATTERN.test(id)) return 64_000;
  if (GEMINI_PATTERN.test(id)) {
    const google = official.get("google");
    if (google) {
      for (const m of google.values()) {
        if (m.maxTokens && m.maxTokens >= 65_536) return m.maxTokens;
      }
    }
    return 65_536;
  }
  return 32_768;
}

function defaultContextForFamily(id: string): number {
  if (GEMINI_PATTERN.test(id)) return 1_048_576;
  if (CLAUDE_PATTERN.test(id)) return 200_000;
  return 200_000;
}

function buildThinkingMap(
  efforts: string[] | undefined,
  supportsNone: boolean,
  isGemini: boolean,
): ChatModel["thinkingLevelMap"] {
  if (!efforts || efforts.length === 0) return undefined;
  const set = new Set(efforts);
  return {
    off: supportsNone ? "none" : null,
    minimal: set.has("minimal") ? "minimal" : null,
    low: set.has("low") ? "low" : null,
    medium: set.has("medium") ? "medium" : null,
    high: set.has("high") ? "high" : null,
    // Google SDK wire format only accepts minimal/low/medium/high; Antigravity selects xhigh via model ID.
    xhigh: set.has("xhigh") ? (isGemini ? "high" : "xhigh") : null,
    max: set.has("max") ? (isGemini ? "high" : "max") : null,
  };
}

export function buildAntigravityModel(
  providerId: string,
  id: string,
  manifest: ManifestEntry | undefined,
  official: MetadataIndex,
  root: string,
  apiBase: string,
): ChatModel {
  const isClaude = CLAUDE_PATTERN.test(id);
  const isGemini = GEMINI_PATTERN.test(id);
  const isDisabled = /-disabled$/i.test(id);

  const baseId = stripVariantSuffix(id);
  const candidates = baseId !== id ? [id, baseId] : [id];
  const providers = isClaude
    ? ["anthropic", "antigravity"]
    : isGemini
      ? ["google", "antigravity"]
      : ["antigravity", "openai", "google"];
  const meta = lookupMetadata(official, providers, candidates);

  const validManifest = isManifestPlaceholder(manifest) ? undefined : manifest;
  const contextWindow =
    positiveInt(validManifest?.context_window, meta?.contextWindow) ?? defaultContextForFamily(id);

  const maxTokens = Math.min(
    contextWindow,
    positiveInt(validManifest?.max_output_tokens, validManifest?.max_tokens, meta?.maxTokens) ??
      defaultMaxTokensForFamily(id, official),
  );

  const parsedEfforts = validManifest
    ? parseSupportedEfforts(validManifest.supported_reasoning_levels)
    : undefined;
  const reasoning = isDisabled
    ? false
    : parsedEfforts !== undefined
      ? parsedEfforts.efforts.length > 0
      : meta?.reasoning ?? (isClaude || isGemini);

  const input =
    parseInputModalities(validManifest?.input_modalities) ?? meta?.input ?? ["text", "image"];

  const api: Sub2ApiApi = isClaude
    ? "anthropic-messages"
    : isGemini
      ? "google-generative-ai"
      : "openai-responses";

  const baseUrl = isClaude
    ? `${root}/antigravity`
    : isGemini
      ? `${root}/antigravity/v1beta`
      : apiBase;

  return {
    id,
    name: manifest?.display_name || id,
    api,
    provider: providerId,
    baseUrl,
    reasoning,
    input,
    cost: meta?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    thinkingLevelMap: reasoning
      ? buildThinkingMap(parsedEfforts?.efforts, Boolean(parsedEfforts?.supportsNone), isGemini)
      : undefined,
    promptCache: meta?.promptCache,
    inputLimits: meta?.inputLimits,
    samplingParams: meta?.samplingParams,
    samplingParamsByThinkingLevel: meta?.samplingParamsByThinkingLevel,
    compat:
      isClaude && /^claude-(?:fable-5|(?:haiku|opus|sonnet)-(?:4-[6-9]|[5-9]))(?:-|$)/i.test(id)
        ? { forceAdaptiveThinking: true }
        : undefined,
  };
}

export interface VariantGroup {
  baseId: string;
  displayName: string;
  variants: Partial<Record<ModelThinkingLevel, ChatModel>>;
  levels: ModelThinkingLevel[];
  representative: ChatModel;
}

function suffixToLevel(suffix: string): ModelThinkingLevel {
  const s = suffix.toLowerCase();
  if (s === "disabled") return "off";
  return s as ModelThinkingLevel;
}

export function cleanGroupDisplayName(baseId: string, representativeName: string): string {
  const cleaned = representativeName
    .replace(/\s*\((?:low|medium|high|xhigh|disabled)\)\s*$/i, "")
    .replace(/-(?:low|medium|high|xhigh|disabled)$/i, "")
    .trim();

  let name = cleaned && cleaned.toLowerCase() !== baseId.toLowerCase() ? cleaned : baseId;
  if (/-tiered$/i.test(baseId) && !/\btiered\b/i.test(name)) {
    name = `${name} (Tiered)`;
  }
  return name;
}

/**
 * Groups Antigravity variant models (e.g. gemini-4-neon-{low,medium,high,xhigh},
 * claude-opus-5-5-{low,medium,high}) into virtual models so the user picks one
 * base model and switches thinking level natively in Pi.
 *
 * Only folds families with >= 2 effort variants whose baseId does not collide
 * with an existing physical model on the same provider.
 */
export function buildAntigravityVirtualGroups(
  models: readonly ChatModel[],
  allPhysicalIds?: ReadonlySet<string>,
): VariantGroup[] {
  const physicalIds = allPhysicalIds ?? new Set(models.map((m) => m.id));
  const buckets = new Map<string, Partial<Record<ModelThinkingLevel, ChatModel>>>();

  for (const model of models) {
    const match = FOLDABLE_SUFFIX.exec(model.id);
    if (!match) continue;
    const baseId = match[1]!;
    if (physicalIds.has(baseId)) continue;
    const level = suffixToLevel(match[2]!);
    let map = buckets.get(baseId);
    if (!map) {
      map = {};
      buckets.set(baseId, map);
    }
    map[level] = model;
  }

  const groups: VariantGroup[] = [];
  for (const [baseId, variants] of buckets) {
    const levels = LEVEL_ORDER.filter((lvl) => variants[lvl] !== undefined);
    if (levels.length < 2) continue;

    // Prefer high -> medium -> first available as representative for initial limits/name
    const representative = variants.high ?? variants.medium ?? variants[levels[0]!]!;
    groups.push({
      baseId,
      displayName: cleanGroupDisplayName(baseId, representative.name),
      variants,
      levels,
      representative,
    });
  }

  return groups;
}

export function pickNearestLevel(
  requested: ModelThinkingLevel,
  available: readonly ModelThinkingLevel[],
  exclude?: ModelThinkingLevel,
): ModelThinkingLevel {
  const candidates = exclude ? available.filter((lvl) => lvl !== exclude) : available;
  const pool = candidates.length > 0 ? candidates : available;
  if (pool.includes(requested)) return requested;

  const reqIdx = FULL_LEVEL_ORDER.indexOf(requested);
  let best = pool[0]!;
  let bestDist = Infinity;
  for (const lvl of pool) {
    const dist = Math.abs(FULL_LEVEL_ORDER.indexOf(lvl) - reqIdx);
    if (dist < bestDist) {
      bestDist = dist;
      best = lvl;
    }
  }
  return best;
}

export interface VirtualModelOptions {
  fallbackOnRateLimit?: boolean;
}

/**
 * Converts a VariantGroup into a Pi native VirtualModel definition.
 * Physical variant IDs remain registered in `provider.getModels()` so routing
 * and session replay resolve cleanly, while `provider.filterModels()` can hide
 * them from `/model`.
 */
export function createAntigravityVirtualModel(
  providerId: string,
  group: VariantGroup,
  options: VirtualModelOptions = {},
): ExtensionVirtualModel {
  const levelByPhysicalId = new Map<string, ModelThinkingLevel>();
  for (const level of group.levels) {
    const variant = group.variants[level];
    if (variant) levelByPhysicalId.set(variant.id, level);
  }

  return {
    provider: providerId,
    id: group.baseId,
    name: group.displayName,
    thinkingLevels: group.levels,
    contextWindow: group.representative.contextWindow,
    maxTokens: group.representative.maxTokens,
    input: group.representative.input,
    route(request, ctx) {
      // Keep tool-loop continuations sticky on the physical variant that started
      // the turn so prompt caches and thinking signatures stay valid.
      if (request.reason === "continuation" && request.previous) {
        const prevLevel = levelByPhysicalId.get(request.previous.model.id);
        if (prevLevel !== undefined) {
          return {
            model: request.previous.model,
            thinkingLevel: prevLevel,
          };
        }
      }

      // On retry, stay sticky unless rate-limit fallback is explicitly enabled.
      if (request.reason === "retry" && request.failed) {
        const failedLevel = levelByPhysicalId.get(request.failed.model.id);
        if (failedLevel !== undefined) {
          const isRateLimit =
            options.fallbackOnRateLimit &&
            typeof request.failed.message.errorMessage === "string" &&
            RATE_LIMIT_ERROR_PATTERN.test(request.failed.message.errorMessage);
          if (isRateLimit && group.levels.length > 1) {
            const fallbackLevel = pickNearestLevel(failedLevel, group.levels, failedLevel);
            const fallbackMeta = group.variants[fallbackLevel];
            const fallbackPhysical = fallbackMeta
              ? (ctx.modelRegistry.find(providerId, fallbackMeta.id) as Model<Api> | undefined)
              : undefined;
            if (fallbackPhysical) {
              return { model: fallbackPhysical, thinkingLevel: fallbackLevel };
            }
          }
          return {
            model: request.failed.model,
            thinkingLevel: failedLevel,
          };
        }
      }

      const targetLevel = pickNearestLevel(request.thinkingLevel, group.levels);
      const targetMeta = group.variants[targetLevel] ?? group.representative;
      const physical = ctx.modelRegistry.find(providerId, targetMeta.id) as Model<Api> | undefined;
      if (!physical) {
        throw new Error(`Sub2API physical variant "${providerId}/${targetMeta.id}" is not registered`);
      }
      return {
        model: physical,
        thinkingLevel: targetLevel,
      };
    },
  };
}
