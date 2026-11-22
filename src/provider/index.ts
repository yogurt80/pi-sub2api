import { createProvider } from "@earendil-works/pi-ai";
import {
  anthropicMessagesApi,
  googleGenerativeAIApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { asObject, redactToken, type Sub2ApiConfig } from "../config.js";
import {
  disambiguateModelNames,
  fetchCodexManifest,
  getCatalogPath,
  loadOfficialMetadata,
  matchesAnyPattern,
  readCatalogSnapshot,
  saveCatalogSnapshot,
  type ChatModel,
  type ManifestEntry,
  type MetadataIndex,
  type Sub2ApiApi,
  type Sub2ApiCatalogSnapshot,
} from "./catalog.js";
import {
  buildAntigravityModel,
  buildAntigravityVirtualGroups,
  createAntigravityVirtualModel,
  fetchAntigravityIds,
  isAntigravityExcluded,
  isManifestPlaceholder,
  type VariantGroup,
} from "./antigravity.js";

const EFFORT_SUFFIX = /-(?:low|medium|high|xhigh|disabled)$/i;
const CODEX_MODEL_PATTERN = /^(?:chatgpt|codex|gpt|o\d)(?:-|$)/i;

interface CatalogSummary {
  visibleCount: number;
  physicalCount: number;
  virtualCount: number;
}

async function fetchV1Ids(apiBase: string, token: string, signal?: AbortSignal): Promise<string[]> {
  const timeout = AbortSignal.timeout(10_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${apiBase}/models`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    signal: combinedSignal,
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

export async function fetchCatalogSnapshot(
  config: Sub2ApiConfig,
  signal?: AbortSignal,
): Promise<Sub2ApiCatalogSnapshot> {
  const [manifestResult, antigravityIds, v1Result] = await Promise.all([
    fetchCodexManifest(config.root, config.token, signal).catch(() => undefined),
    fetchAntigravityIds(config.root, config.token, signal),
    fetchV1Ids(config.apiBase, config.token, signal).catch(() => undefined),
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

export interface BuiltProviderCatalog {
  physicalModels: ChatModel[];
  virtualGroups: VariantGroup[];
  hiddenPhysicalIds: Set<string>;
  visibleCount: number;
}

function shouldKeepModelId(id: string, include: readonly string[], exclude: readonly string[]): boolean {
  const baseId = id.replace(EFFORT_SUFFIX, "");
  const candidates = baseId !== id ? [id, baseId] : [id];

  if (include.length > 0 && !candidates.some((c) => matchesAnyPattern(c, include))) {
    return false;
  }
  if (exclude.length > 0 && candidates.some((c) => matchesAnyPattern(c, exclude))) {
    return false;
  }
  return true;
}

export function buildProviderCatalog(
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

  for (const id of orderedIds) {
    if (!shouldKeepModelId(id, config.include, config.exclude)) continue;
    if (!antigravitySet.has(id) && CODEX_MODEL_PATTERN.test(id) && !/^gpt-oss-/i.test(id)) continue;
    if (isAntigravityExcluded(id) || /^(?:gpt-image|codex-auto-review$)/i.test(id)) continue;

    const manifest = manifestById.get(id);
    if (config.hidePlaceholders && isManifestPlaceholder(manifest)) continue;
    physicalModels.push(buildAntigravityModel(
      config.providerId,
      id,
      manifest,
      official,
      config.root,
      config.apiBase,
    ));
  }

  const virtualGroups = config.foldVariants ? buildAntigravityVirtualGroups(physicalModels) : [];

  const hiddenPhysicalIds = new Set<string>();
  if (config.foldVariants && config.hideFoldedVariants) {
    for (const group of virtualGroups) {
      for (const variant of Object.values(group.variants)) {
        if (variant) hiddenPhysicalIds.add(variant.id);
      }
    }
  }

  // Disambiguate colliding display names among visible physical models
  const visiblePhysical = physicalModels.filter((m) => !hiddenPhysicalIds.has(m.id));
  disambiguateModelNames(visiblePhysical);

  const visibleCount = visiblePhysical.length + virtualGroups.length;

  return {
    physicalModels,
    virtualGroups,
    hiddenPhysicalIds,
    visibleCount,
  };
}

export async function registerSub2ApiProvider(pi: ExtensionAPI, config: Sub2ApiConfig): Promise<void> {
  const catalogPath = getCatalogPath();
  const official = await loadOfficialMetadata();
  const anthropicApi = anthropicMessagesApi();
  const googleApi = googleGenerativeAIApi();
  const responsesApi = openAIResponsesApi();

  let registeredProvider = false;
  let registeredVirtualIds = new Set<string>();
  let hasCatalog = false;
  let lastSnapshotFetchedAt = 0;

  const applySnapshot = (snapshot: Sub2ApiCatalogSnapshot): CatalogSummary => {
    const built = buildProviderCatalog(snapshot, official, config);
    const summary: CatalogSummary = {
      visibleCount: built.visibleCount,
      physicalCount: built.physicalModels.length,
      virtualCount: built.virtualGroups.length,
    };
    hasCatalog = true;
    lastSnapshotFetchedAt = snapshot.fetchedAt;

    const nextVirtualIds = new Set(built.virtualGroups.map((g) => g.baseId));

    // Unregister only virtual models that disappeared
    for (const oldId of registeredVirtualIds) {
      if (!nextVirtualIds.has(oldId)) {
        try {
          pi.unregisterVirtualModel(config.providerId, oldId);
        } catch {
          // Ignore if already removed
        }
      }
    }

    if (!built.physicalModels.length) {
      if (registeredProvider) pi.unregisterProvider(config.providerId);
      registeredProvider = false;
      registeredVirtualIds = nextVirtualIds;
      return summary;
    }

    const provider = createProvider<Sub2ApiApi>({
      id: config.providerId,
      name: "Sub2API",
      baseUrl: config.apiBase,
      auth: {
        apiKey: {
          name: "Sub2API API key",
          check: async () => ({ type: "api_key", source: "sub2api.json" }),
          resolve: async () => ({
            auth: { apiKey: config.token },
            source: "sub2api.json",
          }),
        },
      },
      models: built.physicalModels,
      filterModels:
        built.hiddenPhysicalIds.size > 0
          ? (models) => models.filter((m) => !built.hiddenPhysicalIds.has(m.id))
          : undefined,
      api: {
        "anthropic-messages": anthropicApi,
        "google-generative-ai": googleApi,
        "openai-responses": responsesApi,
      },
    });

    pi.registerProvider(provider);
    registeredProvider = true;

    for (const group of built.virtualGroups) {
      pi.registerVirtualModel(
        createAntigravityVirtualModel(config.providerId, group, {
          fallbackOnRateLimit: config.fallbackOnRateLimit,
        }),
      );
    }
    registeredVirtualIds = nextVirtualIds;

    return summary;
  };

  let refreshing = false;
  const runRefresh = async (signal?: AbortSignal) => {
    if (refreshing) return undefined;
    refreshing = true;
    try {
      const snapshot = await fetchCatalogSnapshot(config, signal);
      const summary = applySnapshot(snapshot);
      await saveCatalogSnapshot(snapshot, catalogPath);
      return summary;
    } finally {
      refreshing = false;
    }
  };

  // Load local snapshot immediately (zero startup latency when cached)
  const cached = await readCatalogSnapshot(catalogPath);
  if (cached) {
    applySnapshot(cached);
  } else {
    // First-run bootstrap: attempt a quick initial fetch so /model & --list-models work immediately
    try {
      await runRefresh(AbortSignal.timeout(8_000));
    } catch {
      // Will retry on session_start or via /sub2api-refresh
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const needsInitial = !hasCatalog;
    const maxAgeMs = config.autoRefreshHours * 3_600_000;
    const isStale =
      config.autoRefreshHours > 0 &&
      lastSnapshotFetchedAt > 0 &&
      Date.now() - lastSnapshotFetchedAt > maxAgeMs;

    if (needsInitial || isStale) {
      void runRefresh()
        .then((summary) => {
          if (summary?.visibleCount && needsInitial && ctx.hasUI) {
            ctx.ui.notify(
              `Loaded ${summary.visibleCount} Antigravity models (${summary.virtualCount} folded).`,
              "info",
            );
          }
        })
        .catch((error) => {
          if (needsInitial && ctx.hasUI) {
            const msg = redactToken(error instanceof Error ? error.message : String(error), config.token);
            ctx.ui.notify(`Antigravity model fetch failed: ${msg}. Run /sub2api-refresh to retry.`, "warning");
          }
        });
    }
  });

  pi.registerCommand("sub2api-refresh", {
    description: "Fetch and refresh the Sub2API Antigravity model catalog",
    handler: async (_args, ctx) => {
      if (refreshing) {
        ctx.ui.notify("Antigravity model refresh is already running.", "info");
        return;
      }
      try {
        const summary = await runRefresh();
        if (!summary) return;
        const details =
          summary.virtualCount > 0
            ? `${summary.visibleCount} visible (${summary.physicalCount} physical, ${summary.virtualCount} folded)`
            : `${summary.visibleCount} models`;
        ctx.ui.notify(`Refreshed Antigravity catalog: ${details}.`, "info");
      } catch (error) {
        const raw = error instanceof Error ? error.message : "Unknown error";
        const message = redactToken(raw, config.token);
        ctx.ui.notify(`Antigravity model refresh failed. ${message}`, "error");
      }
    },
  });
}
