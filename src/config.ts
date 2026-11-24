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
  includeRecentInput: boolean;
}

export interface Sub2ApiConfig {
  apiBase: string;
  token: string;
  search: SearchConfig;
}

type JsonObject = Record<string, unknown>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

/**
 * Resolves literal tokens or environment references (`$VAR` / `${VAR}`).
 */
export function resolveEnvToken(raw: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";

  const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(trimmed);
  if (braced) {
    return (env[braced[1]!] ?? "").trim();
  }
  const simple = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  if (simple) {
    return (env[simple[1]!] ?? "").trim();
  }
  return trimmed;
}

export function normalizeRoot(baseURL: string): string {
  let url: URL;
  try {
    url = new URL(baseURL.trim());
  } catch {
    throw new Error(`Invalid baseURL in ${CONFIG_FILE}`);
  }
  const isHttpLoopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if ((url.protocol !== "https:" && !isHttpLoopback) || url.username || url.password || url.search || url.hash) {
    throw new Error(
      "baseURL must be an HTTPS URL (or HTTP for localhost/127.0.0.1) without credentials, query, or fragment",
    );
  }
  return url.href.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function redactToken(text: string, ...tokens: Array<string | undefined>): string {
  let out = text;
  for (const token of tokens) {
    if (token && token.length >= 4) {
      out = out.replaceAll(token, "[REDACTED]");
    }
  }
  return out;
}

export function getConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE);
}

export function parseSub2ApiConfig(
  raw: string,
  env: NodeJS.ProcessEnv = process.env,
): Sub2ApiConfig {
  let parsed: JsonObject | undefined;
  try {
    parsed = asObject(JSON.parse(raw));
  } catch {
    throw new Error(`${CONFIG_FILE} is not valid JSON`);
  }
  if (!parsed) throw new Error(`${CONFIG_FILE} must be a JSON object`);

  // Support unified flat format or legacy `{ "sub2api": { baseURL, token } }`
  let baseObj: JsonObject = parsed;
  if (typeof parsed.baseURL !== "string") {
    const legacyKey = Object.keys(parsed).find((k) => {
      const entry = asObject(parsed![k]);
      return typeof entry?.baseURL === "string";
    });
    if (legacyKey) {
      baseObj = asObject(parsed[legacyKey])!;
    }
  }

  const baseURL = baseObj.baseURL;
  if (typeof baseURL !== "string" || !baseURL.trim()) {
    throw new Error(`${CONFIG_FILE} requires baseURL`);
  }

  const rawToken = typeof baseObj.token === "string" ? baseObj.token : undefined;
  const cleanToken = resolveEnvToken(rawToken, env) || (env.SUB2API_TOKEN ?? "").trim();
  if (!cleanToken) {
    throw new Error(
      rawToken?.startsWith("$")
        ? `${CONFIG_FILE} token reference "${rawToken.trim()}" is not set in environment`
        : `${CONFIG_FILE} requires token (or SUB2API_TOKEN environment variable)`,
    );
  }

  const apiBase = `${normalizeRoot(baseURL)}/v1`;

  const searchSection = asObject(parsed.search) ?? asObject(baseObj.search);
  const searchEnabled =
    typeof searchSection?.enabled === "boolean" ? searchSection.enabled : true;
  const searchEndpoint =
    typeof searchSection?.endpoint === "string" && searchSection.endpoint.trim()
      ? searchSection.endpoint.trim()
      : `${apiBase}/alpha/search`;
  const rawSearchToken = typeof searchSection?.token === "string" ? searchSection.token : undefined;
  const searchToken = resolveEnvToken(rawSearchToken, env) || cleanToken;
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
    apiBase,
    token: cleanToken,
    search: {
      enabled: searchEnabled,
      endpoint: searchEndpoint,
      token: searchToken,
      model: searchModel,
      timeoutMs: searchTimeoutMs,
      live: searchLive,
      includeRecentInput: searchSection?.includeRecentInput === true,
    },
  };
}

/**
 * Reads ~/.pi/agent/sub2api.json.
 * Returns undefined if the file does not exist.
 */
export async function readSub2ApiConfig(configPath = getConfigPath()): Promise<Sub2ApiConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read ${CONFIG_FILE}`);
  }
  return parseSub2ApiConfig(raw);
}
