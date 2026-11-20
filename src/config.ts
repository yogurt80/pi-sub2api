import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE = "sub2api.json";

export interface SearchConfig {
  enabled: boolean;
  endpoint: string;
  token: string;
  model: string;
  timeoutMs: number;
  live: boolean;
}

export interface Sub2ApiConfig {
  providerId: string;
  root: string;
  apiBase: string;
  token: string;
  foldVariants: boolean;
  search: SearchConfig;
}

type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function normalizeRoot(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL.trim());
  } catch {
    throw new Error(`Invalid baseURL in ${CONFIG_FILE}`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("baseURL must be an HTTPS URL without credentials, query, or fragment");
  }
  return url.href.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Reads ~/.pi/agent/sub2api.json.
 * Supports both unified flat schema:
 *   { "baseURL": "...", "token": "...", "provider": { "id": "sub2api", "foldVariants": true }, "search": { ... } }
 * and legacy nested schema:
 *   { "sub2api": { "baseURL": "...", "token": "..." } }
 */
export async function readSub2ApiConfig(): Promise<Sub2ApiConfig | undefined> {
  const configPath = join(getAgentDir(), CONFIG_FILE);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${CONFIG_FILE}`);
  }

  let parsed: JsonObject | undefined;
  try {
    parsed = asObject(JSON.parse(raw));
  } catch {
    throw new Error(`${CONFIG_FILE} is not valid JSON`);
  }
  if (!parsed) throw new Error(`${CONFIG_FILE} must be a JSON object`);

  // Support unified flat format or legacy `{ "sub2api": { baseURL, token } }`
  let baseObj: JsonObject = parsed;
  let defaultProviderId = "sub2api";
  if (typeof parsed.baseURL !== "string") {
    const legacyKey = Object.keys(parsed).find((k) => {
      const entry = asObject(parsed![k]);
      return typeof entry?.baseURL === "string" && typeof entry?.token === "string";
    });
    if (legacyKey) {
      baseObj = asObject(parsed[legacyKey])!;
      defaultProviderId = legacyKey;
    }
  }

  const baseURL = baseObj.baseURL;
  const token = baseObj.token;
  if (typeof baseURL !== "string" || typeof token !== "string" || !token.trim()) {
    throw new Error(`${CONFIG_FILE} requires baseURL and token`);
  }

  const root = normalizeRoot(baseURL);
  const apiBase = `${root}/v1`;
  const cleanToken = token.trim();

  const providerSection = asObject(parsed.provider) ?? asObject(baseObj.provider);
  const providerId =
    typeof providerSection?.id === "string" && providerSection.id.trim()
      ? providerSection.id.trim()
      : defaultProviderId;
  const foldVariants =
    typeof providerSection?.foldVariants === "boolean" ? providerSection.foldVariants : true;

  const searchSection = asObject(parsed.search) ?? asObject(baseObj.search);
  const searchEnabled =
    typeof searchSection?.enabled === "boolean" ? searchSection.enabled : true;
  const searchEndpoint =
    typeof searchSection?.endpoint === "string" && searchSection.endpoint.trim()
      ? searchSection.endpoint.trim()
      : `${apiBase}/alpha/search`;
  const searchToken =
    typeof searchSection?.token === "string" && searchSection.token.trim()
      ? searchSection.token.trim()
      : cleanToken;
  const searchModel =
    typeof searchSection?.model === "string" && searchSection.model.trim()
      ? searchSection.model.trim()
      : "gpt-6-luna";
  const searchTimeoutMs =
    typeof searchSection?.timeoutMs === "number" && searchSection.timeoutMs > 0
      ? searchSection.timeoutMs
      : 30_000;
  const searchLive = Boolean(searchSection?.live);

  return {
    providerId,
    root,
    apiBase,
    token: cleanToken,
    foldVariants,
    search: {
      enabled: searchEnabled,
      endpoint: searchEndpoint,
      token: searchToken,
      model: searchModel,
      timeoutMs: searchTimeoutMs,
      live: searchLive,
    },
  };
}

/** Escape Pi's API-key interpolation syntax for literal keys. */
export function escapePiApiKey(token: string): string {
  return token.replace(/\$/g, "$$$$").replace(/^!/, "$!");
}
