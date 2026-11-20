import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { asObject, escapePiApiKey, type Sub2ApiConfig } from "../config.js";
import {
  getCatalogPath,
  loadOfficialMetadata,
  readCatalogSnapshot,
  saveCatalogSnapshot,
  type ChatModel,
  type ManifestEntry,
  type MetadataIndex,
  type Sub2ApiCatalogSnapshot,
} from "./catalog.js";
import { buildCodexModel, createCodexStreamSimple, fetchCodexManifest, isCodexModel } from "./codex.js";
import {
  buildAntigravityModel,
  buildAntigravityVirtualGroups,
  createAntigravityVirtualModel,
  fetchAntigravityIds,
  isAntigravityExcluded,
} from "./antigravity.js";

async function fetchV1Ids(apiBase: string, token: string): Promise<string[]> {
  const response = await fetch(`${apiBase}/models`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Sub2API /v1/models failed (HTTP ${response.status})`);
  }
  const payload = asObject(await response.json().catch(() => undefined));
  if (!Array.isArray(payload?.data)) {
    throw new Error("Sub2API /v1/models returned an invalid catalog");
  }
  const ids: string[] = [];
  for (const item of payload.data) {
    const id = asObject(item)?.id;
    if (typeof id === "string" && id.trim()) ids.push(id.trim());
  }
  return ids;
}

async function fetchCatalogSnapshot(config: Sub2ApiConfig): Promise<Sub2ApiCatalogSnapshot> {
  const [manifestResult, antigravityIds, v1Result] = await Promise.all([
    fetchCodexManifest(config.root, config.token).catch(() => undefined),
    fetchAntigravityIds(config.root, config.token),
    fetchV1Ids(config.apiBase, config.token).catch(() => undefined),
  ]);

  const codexManifest = manifestResult ?? [];
  const v1Ids = v1Result ?? [];
  if (codexManifest.length === 0 && v1Ids.length === 0) {
    throw new Error("Sub2API returned no models from /backend-api/codex/models or /v1/models");
  }

  return {
    version: 2,
    fetchedAt: Date.now(),
    codexManifest,
    antigravityIds,
    v1Ids,
  };
}

interface BuiltProviderCatalog {
  physicalModels: ChatModel[];
  antigravityModels: ChatModel[];
}

function buildCatalog(
  snapshot: Sub2ApiCatalogSnapshot,
  official: MetadataIndex,
  config: Sub2ApiConfig,
): BuiltProviderCatalog {
  const manifestById = new Map<string, ManifestEntry>();
  for (const entry of snapshot.codexManifest) {
    manifestById.set(entry.slug, entry);
  }
  const antigravitySet = new Set(snapshot.antigravityIds);

  // Union of discovered model IDs (manifest first to keep upstream ordering, then /v1/models)
  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of snapshot.codexManifest) {
    if (!seen.has(entry.slug)) {
      seen.add(entry.slug);
      orderedIds.push(entry.slug);
    }
  }
  for (const id of snapshot.v1Ids) {
    if (!seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }

  const physicalModels: ChatModel[] = [];
  const antigravityModels: ChatModel[] = [];

  for (const id of orderedIds) {
    const manifest = manifestById.get(id);
    if (isCodexModel(id, antigravitySet)) {
      physicalModels.push(buildCodexModel(id, manifest, official, config.apiBase));
      continue;
    }
    if (isAntigravityExcluded(id)) continue;
    // Skip non-chat OpenAI models like gpt-image-* or codex-auto-review
    if (/^(?:gpt-image|codex-auto-review$)/i.test(id)) continue;

    const model = buildAntigravityModel(id, manifest, official, config.root, config.apiBase);
    physicalModels.push(model);
    antigravityModels.push(model);
  }

  return { physicalModels, antigravityModels };
}

export async function registerSub2ApiProvider(pi: ExtensionAPI, config: Sub2ApiConfig): Promise<void> {
  const catalogPath = getCatalogPath();
  const apiKey = escapePiApiKey(config.token);
  const streamSimple = createCodexStreamSimple(config.apiBase, config.token);
  const official = await loadOfficialMetadata();

  let registeredVirtualIds: string[] = [];

  const applySnapshot = (snapshot: Sub2ApiCatalogSnapshot) => {
    const { physicalModels, antigravityModels } = buildCatalog(snapshot, official, config);
    if (!physicalModels.length) return { physicalCount: 0, virtualCount: 0 };

    // Remove previously registered virtual models before re-registering provider
    for (const id of registeredVirtualIds) {
      try {
        pi.unregisterVirtualModel(config.providerId, id);
      } catch {
        // Ignore if not currently registered
      }
    }
    registeredVirtualIds = [];

    pi.registerProvider(config.providerId, {
      name: "Sub2API",
      baseUrl: config.apiBase,
      apiKey,
      api: "openai-codex-responses",
      streamSimple,
      models: physicalModels,
    });

    if (config.foldVariants) {
      const allPhysicalIds = new Set(physicalModels.map((m) => m.id));
      const groups = buildAntigravityVirtualGroups(antigravityModels, allPhysicalIds);
      for (const group of groups) {
        pi.registerVirtualModel(createAntigravityVirtualModel(config.providerId, group));
        registeredVirtualIds.push(group.baseId);
      }
    }

    return {
      physicalCount: physicalModels.length,
      virtualCount: registeredVirtualIds.length,
    };
  };

  // Load local snapshot immediately (zero startup network latency)
  const cached = await readCatalogSnapshot(catalogPath);
  if (cached) {
    applySnapshot(cached);
  }

  let refreshing = false;
  pi.registerCommand("sub2api-refresh", {
    description: "Fetch and refresh Sub2API Codex & Antigravity model catalog",
    handler: async (_args, ctx) => {
      if (refreshing) {
        ctx.ui.notify("Sub2API model refresh is already running.", "info");
        return;
      }
      refreshing = true;
      try {
        const snapshot = await fetchCatalogSnapshot(config);
        const { physicalCount, virtualCount } = applySnapshot(snapshot);
        if (!physicalCount) {
          throw new Error("Sub2API returned no chat models");
        }
        await saveCatalogSnapshot(snapshot, catalogPath);
        const suffix = virtualCount > 0 ? ` (+ ${virtualCount} folded virtual models)` : "";
        ctx.ui.notify(`Refreshed ${physicalCount} Sub2API models${suffix}.`, "info");
      } catch (error) {
        const raw = error instanceof Error ? error.message : "Unknown error";
        const message = raw.replaceAll(config.token, "[REDACTED]");
        ctx.ui.notify(`Sub2API model refresh failed. ${message}`, "error");
      } finally {
        refreshing = false;
      }
    },
  });
}
