import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Api, Model, ModelCost } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { asObject } from "../config.js";

export type Sub2ApiApi =
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "openai-responses";

export type ChatModel = Model<Sub2ApiApi>;

export interface ManifestEntry {
  slug: string;
  display_name?: string;
  description?: string;
  comp_hash?: string;
  context_window?: number;
  max_context_window?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  input_modalities?: unknown;
  supported_reasoning_levels?: unknown;
  default_reasoning_level?: string;
  reasoning?: boolean;
}

export interface Sub2ApiCatalogSnapshot {
  version: 2;
  fetchedAt: number;
  codexManifest: ManifestEntry[];
  antigravityIds: string[];
  v1Ids: string[];
}

export interface OfficialMetadata {
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  promptCache?: Model<Api>["promptCache"];
  inputLimits?: Model<Api>["inputLimits"];
  samplingParams?: Model<Api>["samplingParams"];
  samplingParamsByThinkingLevel?: Model<Api>["samplingParamsByThinkingLevel"];
}

export type MetadataIndex = Map<string, Map<string, OfficialMetadata>>;

export interface ParsedEfforts {
  efforts: string[];
  supportsNone: boolean;
}

const CATALOG_FILE = "sub2api-catalog.json";
const BUILTIN_PROVIDERS = ["openai-codex", "openai", "google", "anthropic"] as const;
const STORE_PROVIDERS = ["openai-codex", "openai", "google", "anthropic", "antigravity"] as const;

export function positiveInt(...values: unknown[]): number | undefined {
  return values.find(
    (v): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= 10_000_000,
  );
}

export function parseInputModalities(value: unknown): ("text" | "image")[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is "text" | "image" => v === "text" || v === "image");
  return items.length > 0 ? [...new Set(items)] : undefined;
}

export function parseSupportedEfforts(value: unknown): ParsedEfforts | undefined {
  if (!Array.isArray(value)) return undefined;
  const efforts: string[] = [];
  let supportsNone = false;
  for (const item of value) {
    const raw = typeof item === "string" ? item : asObject(item)?.effort;
    if (typeof raw !== "string") continue;
    const norm = raw.trim().toLowerCase();
    if (!norm) continue;
    if (norm === "none") {
      supportsNone = true;
      continue;
    }
    if (!efforts.includes(norm)) {
      efforts.push(norm);
    }
  }
  return { efforts, supportsNone };
}

function extractOfficialMetadata(model: Record<string, unknown>): OfficialMetadata {
  const meta: OfficialMetadata = {};
  if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
    meta.contextWindow = model.contextWindow;
  }
  if (typeof model.maxTokens === "number" && model.maxTokens > 0) {
    meta.maxTokens = model.maxTokens;
  }
  if (asObject(model.cost)) {
    meta.cost = model.cost as ModelCost;
  }
  const input = parseInputModalities(model.input);
  if (input) {
    meta.input = input;
  }
  if (typeof model.reasoning === "boolean") {
    meta.reasoning = model.reasoning;
  }
  if (asObject(model.thinkingLevelMap)) {
    meta.thinkingLevelMap = model.thinkingLevelMap as Model<Api>["thinkingLevelMap"];
  }
  if (asObject(model.promptCache)) {
    meta.promptCache = model.promptCache as Model<Api>["promptCache"];
  }
  if (asObject(model.inputLimits)) {
    meta.inputLimits = model.inputLimits as Model<Api>["inputLimits"];
  }
  if (asObject(model.samplingParams)) {
    meta.samplingParams = model.samplingParams as Model<Api>["samplingParams"];
  }
  if (asObject(model.samplingParamsByThinkingLevel)) {
    meta.samplingParamsByThinkingLevel =
      model.samplingParamsByThinkingLevel as Model<Api>["samplingParamsByThinkingLevel"];
  }
  return meta;
}

/**
 * Loads Pi's official built-in model catalogs overlaid directly with the local
 * offline models-store.json cache (zero network requests, no ModelRuntime bootstrap).
 */
export async function loadOfficialMetadata(agentDir = getAgentDir()): Promise<MetadataIndex> {
  const index: MetadataIndex = new Map();

  // 1. Static built-in models
  for (const provider of BUILTIN_PROVIDERS) {
    const map = new Map<string, OfficialMetadata>();
    try {
      for (const m of getBuiltinModels(provider as never)) {
        map.set(m.id, extractOfficialMetadata(m as unknown as Record<string, unknown>));
      }
    } catch {
      // Ignore unavailable builtin provider
    }
    index.set(provider, map);
  }

  // 2. Overlay Pi's offline models-store.json directly
  const modelsStorePath = join(agentDir, "models-store.json");
  try {
    const parsed = asObject(JSON.parse(await readFile(modelsStorePath, "utf8")));
    if (parsed) {
      for (const provider of STORE_PROVIDERS) {
        const entry = asObject(parsed[provider]);
        const models = entry?.models;
        if (!Array.isArray(models)) continue;
        let map = index.get(provider);
        if (!map) {
          map = new Map<string, OfficialMetadata>();
          index.set(provider, map);
        }
        for (const item of models) {
          const obj = asObject(item);
          if (!obj || typeof obj.id !== "string" || !obj.id.trim()) continue;
          if (obj.type !== undefined && obj.type !== "chat") continue;
          const prev = map.get(obj.id);
          map.set(obj.id, { ...prev, ...extractOfficialMetadata(obj) });
        }
      }
    }
  } catch {
    // Offline cache unavailable or malformed; keep static builtins
  }

  return index;
}

export function lookupMetadata(
  index: MetadataIndex,
  providers: readonly string[],
  candidateIds: readonly string[],
): OfficialMetadata | undefined {
  for (const id of candidateIds) {
    for (const provider of providers) {
      const hit = index.get(provider)?.get(id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/**
 * Matches a model ID against glob patterns (`*`, `?`) or `/regex/flags`.
 */
export function matchesAnyPattern(id: string, patterns: readonly string[]): boolean {
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    const regexMatch = /^\/(.+)\/([a-z]*)$/.exec(pattern);
    if (regexMatch) {
      try {
        if (new RegExp(regexMatch[1]!, regexMatch[2] || "i").test(id)) return true;
      } catch {
        // Ignore invalid regex pattern
      }
      continue;
    }
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    if (new RegExp(`^${escaped}$`, "i").test(id)) return true;
  }
  return false;
}

/**
 * When multiple distinct physical models share the same upstream display name
 * (e.g. aliased legacy models all named "Gemini 3.5 Flash Lite"), disambiguate
 * them by falling back to `name [id]` so /model entries stay distinguishable.
 */
export function disambiguateModelNames(models: ChatModel[]): void {
  const counts = new Map<string, number>();
  for (const m of models) {
    const key = m.name.trim().toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const m of models) {
    const key = m.name.trim().toLowerCase();
    if ((counts.get(key) ?? 0) > 1 && m.name.toLowerCase() !== m.id.toLowerCase()) {
      m.name = `${m.name} [${m.id}]`;
    }
  }
}

export function getCatalogPath(): string {
  return join(getAgentDir(), CATALOG_FILE);
}

export async function readCatalogSnapshot(path = getCatalogPath()): Promise<Sub2ApiCatalogSnapshot | undefined> {
  try {
    const parsed = asObject(JSON.parse(await readFile(path, "utf8")));
    if (!parsed) return undefined;
    if (parsed.version === 2 && Array.isArray(parsed.codexManifest)) {
      return {
        version: 2,
        fetchedAt: typeof parsed.fetchedAt === "number" ? parsed.fetchedAt : 0,
        codexManifest: parsed.codexManifest as ManifestEntry[],
        antigravityIds: Array.isArray(parsed.antigravityIds)
          ? parsed.antigravityIds.filter((v): v is string => typeof v === "string")
          : [],
        v1Ids: Array.isArray(parsed.v1Ids)
          ? parsed.v1Ids.filter((v): v is string => typeof v === "string")
          : [],
      };
    }
    // Backwards compatibility with legacy v1 catalog ({ models: [{ id, display_name }] })
    if (Array.isArray(parsed.models)) {
      const v1Ids: string[] = [];
      for (const item of parsed.models) {
        const obj = asObject(item);
        if (typeof obj?.id === "string" && obj.id.trim()) v1Ids.push(obj.id.trim());
      }
      if (v1Ids.length) {
        return { version: 2, fetchedAt: 0, codexManifest: [], antigravityIds: [], v1Ids };
      }
    }
  } catch {
    // Missing or invalid cache; refresh will recreate it
  }
  return undefined;
}

export async function saveCatalogSnapshot(
  snapshot: Sub2ApiCatalogSnapshot,
  path = getCatalogPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
