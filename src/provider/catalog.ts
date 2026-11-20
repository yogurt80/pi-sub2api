import { randomUUID } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryCredentialStore, type Api, type Model, type ModelCost } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { asObject } from "../config.js";

export type ChatModel = Extract<NonNullable<ProviderConfig["models"]>[number], { reasoning: boolean }>;

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
}

export type MetadataIndex = Map<string, Map<string, OfficialMetadata>>;

const CATALOG_FILE = "sub2api-catalog.json";
const OFFICIAL_PROVIDERS = ["openai-codex", "openai", "google", "anthropic", "antigravity"] as const;

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

export function parseSupportedEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const efforts: string[] = [];
  for (const item of value) {
    const raw = typeof item === "string" ? item : asObject(item)?.effort;
    if (typeof raw !== "string") continue;
    const norm = raw.trim().toLowerCase();
    if (norm && norm !== "none" && !efforts.includes(norm)) {
      efforts.push(norm);
    }
  }
  return efforts;
}

/**
 * Loads Pi's official built-in model catalogs merged with the local offline
 * models-store.json cache (via Pi's own ModelRuntime, zero network requests).
 */
export async function loadOfficialMetadata(): Promise<MetadataIndex> {
  const index: MetadataIndex = new Map();

  // 1. Static built-in models
  for (const provider of OFFICIAL_PROVIDERS) {
    const map = new Map<string, OfficialMetadata>();
    try {
      for (const m of getBuiltinModels(provider as never)) {
        map.set(m.id, {
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          cost: m.cost,
          input: m.input,
          reasoning: m.reasoning,
          thinkingLevelMap: m.thinkingLevelMap,
        });
      }
    } catch {
      // Provider may not exist in static builtins (e.g. antigravity)
    }
    index.set(provider, map);
  }

  // 2. Overlay Pi's offline models-store.json via official ModelRuntime
  const agentDir = getAgentDir();
  const modelsStorePath = join(agentDir, "models-store.json");
  try {
    await access(modelsStorePath);
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath,
      allowModelNetwork: false,
      signal: AbortSignal.timeout(4_000),
    });
    for (const provider of OFFICIAL_PROVIDERS) {
      const map = index.get(provider) ?? new Map<string, OfficialMetadata>();
      for (const m of runtime.getModels(provider)) {
        map.set(m.id, {
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          cost: m.cost,
          input: m.input,
          reasoning: m.reasoning,
          thinkingLevelMap: m.thinkingLevelMap,
        });
      }
      index.set(provider, map);
    }
  } catch {
    // Offline cache unavailable; keep static builtins
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
    // Missing or invalid cache; /sub2api-refresh will recreate it
  }
  return undefined;
}

export async function saveCatalogSnapshot(
  snapshot: Sub2ApiCatalogSnapshot,
  path = getCatalogPath(),
): Promise<void> {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
