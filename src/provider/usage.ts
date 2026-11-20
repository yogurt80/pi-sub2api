import { asObject, redactToken } from "../config.js";

export interface UsageBucket {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  cost: number;
  actualCost: number;
}

export interface ModelUsageStat {
  model: string;
  requests: number;
  totalTokens: number;
  actualCost: number;
}

export interface Sub2ApiUsage {
  balance?: number;
  remaining?: number;
  unit: string;
  planName?: string;
  mode?: string;
  isValid?: boolean;
  rpm?: number;
  tpm?: number;
  averageDurationMs?: number;
  today?: UsageBucket;
  total?: UsageBucket;
  modelStats: ModelUsageStat[];
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseBucket(raw: unknown): UsageBucket | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;
  return {
    requests: asNumber(obj.requests) ?? 0,
    inputTokens: asNumber(obj.input_tokens) ?? 0,
    outputTokens: asNumber(obj.output_tokens) ?? 0,
    cacheReadTokens: asNumber(obj.cache_read_tokens) ?? 0,
    cacheCreationTokens: asNumber(obj.cache_creation_tokens) ?? 0,
    totalTokens: asNumber(obj.total_tokens) ?? 0,
    cost: asNumber(obj.cost) ?? 0,
    actualCost: asNumber(obj.actual_cost) ?? asNumber(obj.cost) ?? 0,
  };
}

export async function fetchSub2ApiUsage(
  root: string,
  token: string,
  signal?: AbortSignal,
): Promise<Sub2ApiUsage> {
  const timeout = AbortSignal.timeout(10_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${root}/v1/usage`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    signal: combinedSignal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      redactToken(`Sub2API /v1/usage failed (HTTP ${response.status}) ${text.slice(0, 160)}`.trim(), token),
    );
  }
  const payload = asObject(await response.json().catch(() => undefined));
  if (!payload) {
    throw new Error("Sub2API /v1/usage returned an invalid JSON payload");
  }

  const usageObj = asObject(payload.usage);
  const rawStats = Array.isArray(payload.model_stats) ? payload.model_stats : [];
  const modelStats: ModelUsageStat[] = [];
  for (const item of rawStats) {
    const obj = asObject(item);
    if (!obj || typeof obj.model !== "string") continue;
    modelStats.push({
      model: obj.model,
      requests: asNumber(obj.requests) ?? 0,
      totalTokens: asNumber(obj.total_tokens) ?? 0,
      actualCost: asNumber(obj.actual_cost) ?? asNumber(obj.cost) ?? 0,
    });
  }
  modelStats.sort((a, b) => b.actualCost - a.actualCost || b.requests - a.requests);

  return {
    balance: asNumber(payload.balance),
    remaining: asNumber(payload.remaining),
    unit: typeof payload.unit === "string" && payload.unit.trim() ? payload.unit.trim() : "USD",
    planName: typeof payload.planName === "string" ? payload.planName : undefined,
    mode: typeof payload.mode === "string" ? payload.mode : undefined,
    isValid: typeof payload.isValid === "boolean" ? payload.isValid : undefined,
    rpm: asNumber(usageObj?.rpm),
    tpm: asNumber(usageObj?.tpm),
    averageDurationMs: asNumber(usageObj?.average_duration_ms),
    today: parseBucket(usageObj?.today),
    total: parseBucket(usageObj?.total),
    modelStats,
  };
}

export function formatMoney(amount: number, unit = "USD"): string {
  const prefix = unit.toUpperCase() === "USD" ? "$" : `${unit} `;
  return `${prefix}${amount.toFixed(2)}`;
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

export function formatStatusBarText(usage: Sub2ApiUsage): string {
  const parts: string[] = [];
  const bal = usage.remaining ?? usage.balance;
  if (bal !== undefined) {
    parts.push(`Sub2API ${formatMoney(bal, usage.unit)}`);
  }
  if (usage.today) {
    parts.push(`today ${formatMoney(usage.today.actualCost, usage.unit)}`);
  }
  return parts.join(" · ");
}

export interface CatalogSummaryInfo {
  visibleCount: number;
  physicalCount: number;
  virtualCount: number;
  fetchedAt?: number;
}

export function formatUsageReport(usage: Sub2ApiUsage, catalog?: CatalogSummaryInfo): string {
  const lines: string[] = [];
  const bal = usage.remaining ?? usage.balance;
  const plan = usage.planName ? ` (${usage.planName})` : "";
  if (bal !== undefined) {
    lines.push(`Balance: ${formatMoney(bal, usage.unit)}${plan}`);
  }

  if (usage.today) {
    const t = usage.today;
    const totalInput = t.inputTokens + t.cacheReadTokens;
    const cacheRate = totalInput > 0 ? ` (${Math.round((t.cacheReadTokens / totalInput) * 100)}% cached)` : "";
    lines.push(
      `Today: ${formatMoney(t.actualCost, usage.unit)} · ${t.requests} reqs · ${formatTokens(t.totalTokens)} tok${cacheRate}`,
    );
  }

  if (usage.rpm !== undefined || usage.tpm !== undefined || usage.averageDurationMs !== undefined) {
    const metrics: string[] = [];
    if (usage.rpm !== undefined) metrics.push(`${usage.rpm} RPM`);
    if (usage.tpm !== undefined) metrics.push(`${formatTokens(usage.tpm)} TPM`);
    if (usage.averageDurationMs !== undefined) {
      metrics.push(`avg ${(usage.averageDurationMs / 1000).toFixed(1)}s`);
    }
    lines.push(`Rate: ${metrics.join(" · ")}`);
  }

  if (usage.modelStats.length > 0) {
    const top = usage.modelStats
      .slice(0, 4)
      .map((s) => `${s.model} (${s.requests} reqs, ${formatMoney(s.actualCost, usage.unit)})`)
      .join(", ");
    lines.push(`Top models: ${top}`);
  }

  if (catalog) {
    const age = catalog.fetchedAt
      ? `, synced ${Math.max(0, Math.round((Date.now() - catalog.fetchedAt) / 60_000))}m ago`
      : "";
    lines.push(
      `Catalog: ${catalog.visibleCount} visible (${catalog.physicalCount} physical, ${catalog.virtualCount} folded virtual${age})`,
    );
  }

  return lines.join("\n");
}
