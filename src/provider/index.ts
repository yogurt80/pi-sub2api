import { createProvider } from "@earendil-works/pi-ai";
import {
  anthropicMessagesApi,
  googleGenerativeAIApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  asObject,
  normalizeRoot,
  redactToken,
  resolveEnvToken,
  writeSub2ApiConfig,
  type Sub2ApiConfig,
} from "../config.js";
import {
  disambiguateModelNames,
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
  buildCodexModel,
  createCodexStreams,
  fetchCodexManifest,
  isCodexModel,
} from "./codex.js";
import {
  buildAntigravityModel,
  buildAntigravityVirtualGroups,
  createAntigravityVirtualModel,
  fetchAntigravityIds,
  isAntigravityExcluded,
  isManifestPlaceholder,
  type VariantGroup,
} from "./antigravity.js";
import {
  fetchSub2ApiUsage,
  formatStatusBarText,
  formatUsageReport,
  type CatalogSummaryInfo,
} from "./usage.js";

const EFFORT_SUFFIX = /-(?:low|medium|high|xhigh|disabled)$/i;

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
  antigravityModels: ChatModel[];
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
  const antigravityModels: ChatModel[] = [];

  for (const id of orderedIds) {
    if (!shouldKeepModelId(id, config.include, config.exclude)) continue;
    const manifest = manifestById.get(id);

    if (isCodexModel(id, antigravitySet)) {
      physicalModels.push(buildCodexModel(config.providerId, id, manifest, official, config.apiBase));
      continue;
    }
    if (isAntigravityExcluded(id)) continue;
    // Skip non-chat OpenAI models like gpt-image-* or codex-auto-review
    if (/^(?:gpt-image|codex-auto-review$)/i.test(id)) continue;
    // Skip unbacked Sub2API placeholder entries when configured
    if (config.hidePlaceholders && isManifestPlaceholder(manifest)) continue;

    const model = buildAntigravityModel(
      config.providerId,
      id,
      manifest,
      official,
      config.root,
      config.apiBase,
    );
    physicalModels.push(model);
    antigravityModels.push(model);
  }

  const virtualGroups = config.foldVariants
    ? buildAntigravityVirtualGroups(antigravityModels, new Set(physicalModels.map((m) => m.id)))
    : [];

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
    antigravityModels,
    virtualGroups,
    hiddenPhysicalIds,
    visibleCount,
  };
}

export async function registerSub2ApiProvider(pi: ExtensionAPI, config: Sub2ApiConfig): Promise<void> {
  const catalogPath = getCatalogPath();
  const official = await loadOfficialMetadata();
  const codexStreams = createCodexStreams(config.token);
  const anthropicApi = anthropicMessagesApi();
  const googleApi = googleGenerativeAIApi();
  const responsesApi = openAIResponsesApi();

  let registeredVirtualIds = new Set<string>();
  let lastSummary: CatalogSummaryInfo | undefined;
  let lastSnapshotFetchedAt = 0;

  const applySnapshot = (snapshot: Sub2ApiCatalogSnapshot): CatalogSummaryInfo => {
    const built = buildProviderCatalog(snapshot, official, config);
    const summary: CatalogSummaryInfo = {
      visibleCount: built.visibleCount,
      physicalCount: built.physicalModels.length,
      virtualCount: built.virtualGroups.length,
      fetchedAt: snapshot.fetchedAt,
    };
    if (!built.physicalModels.length) return summary;

    lastSummary = summary;
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
        "openai-codex-responses": codexStreams,
        "anthropic-messages": anthropicApi,
        "google-generative-ai": googleApi,
        "openai-responses": responsesApi,
      },
    });

    pi.registerProvider(provider);

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
  const runRefresh = async (options?: { silent?: boolean; signal?: AbortSignal }) => {
    if (refreshing) return undefined;
    refreshing = true;
    try {
      const snapshot = await fetchCatalogSnapshot(config, options?.signal);
      const summary = applySnapshot(snapshot);
      if (!summary.physicalCount) {
        throw new Error("Sub2API returned no chat models");
      }
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
      await runRefresh({ silent: true, signal: AbortSignal.timeout(8_000) });
    } catch {
      // Will retry or allow manual /sub2api-refresh in session
    }
  }

  // Optional status bar refresh with 60s cooldown
  let lastStatusBarUpdate = 0;
  const updateStatusBar = async (ctx: ExtensionContext, force = false) => {
    if (!config.statusBar || !ctx.hasUI) return;
    const now = Date.now();
    if (!force && now - lastStatusBarUpdate < 60_000) return;
    lastStatusBarUpdate = now;
    try {
      const usage = await fetchSub2ApiUsage(config.root, config.token);
      const text = formatStatusBarText(usage);
      if (text) ctx.ui.setStatus("sub2api", text);
    } catch {
      // Keep previous status silently on transient errors
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    void updateStatusBar(ctx, true);

    const needsInitial = !lastSummary;
    const maxAgeMs = config.autoRefreshHours * 3_600_000;
    const isStale =
      config.autoRefreshHours > 0 &&
      lastSnapshotFetchedAt > 0 &&
      Date.now() - lastSnapshotFetchedAt > maxAgeMs;

    if (needsInitial || isStale) {
      void runRefresh({ silent: !needsInitial })
        .then((summary) => {
          if (summary && needsInitial && ctx.hasUI) {
            ctx.ui.notify(
              `Loaded ${summary.visibleCount} Sub2API models (${summary.virtualCount} folded).`,
              "info",
            );
          }
        })
        .catch((error) => {
          if (needsInitial && ctx.hasUI) {
            const msg = redactToken(error instanceof Error ? error.message : String(error), config.token);
            ctx.ui.notify(`Sub2API initial model fetch failed: ${msg}. Run /sub2api-refresh to retry.`, "warning");
          }
        });
    }
  });

  if (config.statusBar) {
    pi.on("turn_end", async (_event, ctx) => {
      void updateStatusBar(ctx, false);
    });
  }

  pi.registerCommand("sub2api-refresh", {
    description: "Fetch and refresh Sub2API Codex & Antigravity model catalog",
    handler: async (_args, ctx) => {
      if (refreshing) {
        ctx.ui.notify("Sub2API model refresh is already running.", "info");
        return;
      }
      try {
        const summary = await runRefresh();
        if (!summary) return;
        const details =
          summary.virtualCount > 0
            ? `${summary.visibleCount} visible (${summary.physicalCount} physical, ${summary.virtualCount} folded)`
            : `${summary.visibleCount} models`;
        ctx.ui.notify(`Refreshed Sub2API catalog: ${details}.`, "info");
      } catch (error) {
        const raw = error instanceof Error ? error.message : "Unknown error";
        const message = redactToken(raw, config.token);
        ctx.ui.notify(`Sub2API model refresh failed. ${message}`, "error");
      }
    },
  });

  pi.registerCommand("sub2api-status", {
    description: "Show Sub2API balance, today's usage, top models, and catalog status",
    handler: async (_args, ctx) => {
      try {
        const usage = await fetchSub2ApiUsage(config.root, config.token);
        const report = formatUsageReport(usage, lastSummary);
        ctx.ui.notify(report || "Sub2API is reachable, but no usage data was returned.", "info");
        if (config.statusBar) {
          const text = formatStatusBarText(usage);
          if (text) ctx.ui.setStatus("sub2api", text);
        }
      } catch (error) {
        const raw = error instanceof Error ? error.message : "Unknown error";
        ctx.ui.notify(`Sub2API status check failed. ${redactToken(raw, config.token)}`, "error");
      }
    },
  });
}

export function registerSub2ApiSetupCommand(
  pi: ExtensionAPI,
  existingConfig?: Sub2ApiConfig,
): void {
  pi.registerCommand("sub2api-setup", {
    description: "Configure Sub2API gateway URL and API key (~/.pi/agent/sub2api.json)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Interactive UI is required for /sub2api-setup.", "error");
        return;
      }

      const rawUrl = await ctx.ui.input(
        "Sub2API Gateway URL (e.g. https://sub2api.example.com)",
        existingConfig?.root ?? "https://",
      );
      if (!rawUrl || !rawUrl.trim()) return;

      let root: string;
      try {
        root = normalizeRoot(rawUrl);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Invalid URL", "error");
        return;
      }

      const rawToken = await ctx.ui.input(
        "Sub2API API Key (literal sk-... or $SUB2API_TOKEN)",
        "$SUB2API_TOKEN",
      );
      if (!rawToken || !rawToken.trim()) return;

      const resolvedToken = resolveEnvToken(rawToken);
      if (!resolvedToken) {
        ctx.ui.notify(
          `Token "${rawToken.trim()}" could not be resolved from environment.`,
          "error",
        );
        return;
      }

      // Verify connectivity before writing config
      try {
        const res = await fetch(`${root}/v1/models`, {
          headers: { Authorization: `Bearer ${resolvedToken}`, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          ctx.ui.notify(`Gateway rejected token (HTTP ${res.status}). Config was not saved.`, "error");
          return;
        }
      } catch (error) {
        const msg = redactToken(error instanceof Error ? error.message : String(error), resolvedToken);
        ctx.ui.notify(`Cannot reach ${root}: ${msg}`, "error");
        return;
      }

      await writeSub2ApiConfig({
        baseURL: root,
        token: rawToken.trim(),
        provider: {
          id: existingConfig?.providerId ?? "sub2api",
          foldVariants: existingConfig?.foldVariants ?? true,
          hideFoldedVariants: existingConfig?.hideFoldedVariants ?? true,
          hidePlaceholders: existingConfig?.hidePlaceholders ?? true,
        },
        search: {
          enabled: existingConfig?.search.enabled ?? true,
          model: existingConfig?.search.model ?? "gpt-6-luna",
          timeoutMs: existingConfig?.search.timeoutMs ?? 30_000,
          live: existingConfig?.search.live ?? false,
        },
      });

      ctx.ui.notify(
        "Saved ~/.pi/agent/sub2api.json (0600). Run /reload (or restart Pi) to activate the new config.",
        "info",
      );
    },
  });
}
