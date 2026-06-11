import type { Env } from "./types";
import { ApiError } from "./errors";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

export type PoolName = "basic" | "super" | "heavy";

export interface TokenPools {
  generic: string[];
  basic: string[];
  super: string[];
  heavy: string[];
}

export function boolEnv(env: Env, key: keyof Env, fallback: boolean): boolean {
  const value = env[key];
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const s = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "y"].includes(s)) return true;
  if (["0", "false", "no", "off", "n"].includes(s)) return false;
  return fallback;
}

export function intEnv(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function floatEnv(env: Env, key: keyof Env, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const n = Number.parseFloat(String(raw));
  return Number.isFinite(n) ? n : fallback;
}

export function csvEnv(env: Env, key: keyof Env): string[] {
  return parseTokenList(env[key]);
}

export function parseTokenList(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return unique(raw.map((x) => normalizeToken(String(x))).filter(Boolean));
  const text = String(raw).trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return unique(parsed.map((x) => normalizeToken(String(x))).filter(Boolean));
    }
  } catch {
    // fall through
  }

  return unique(
    text
      .split(/[,\n\r\t]+/g)
      .map((x) => normalizeToken(x))
      .filter(Boolean),
  );
}

export function normalizeToken(token: string): string {
  let out = token.trim();
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1).trim();
  }
  if (out.startsWith("sso=")) out = out.slice(4);
  return out.replace(/\s+/g, "");
}

export function loadTokenPools(env: Env): TokenPools {
  const pools: TokenPools = {
    generic: unique([...csvEnv(env, "GROK_TOKENS"), ...csvEnv(env, "GROK_SSO_TOKENS")]),
    basic: csvEnv(env, "GROK_BASIC_TOKENS"),
    super: csvEnv(env, "GROK_SUPER_TOKENS"),
    heavy: csvEnv(env, "GROK_HEAVY_TOKENS"),
  };

  const rawJson = env.ACCOUNT_POOL_JSON;
  if (rawJson && rawJson.trim()) {
    try {
      const obj = JSON.parse(rawJson) as Record<string, unknown>;
      for (const key of ["basic", "super", "heavy"] as const) {
        const value = obj[key];
        if (Array.isArray(value)) {
          pools[key] = unique([...pools[key], ...parseTokenList(value)]);
        } else if (typeof value === "string") {
          pools[key] = unique([...pools[key], ...parseTokenList(value)]);
        }
      }
      const generic = obj.generic ?? obj.tokens;
      if (Array.isArray(generic) || typeof generic === "string") {
        pools.generic = unique([...pools.generic, ...parseTokenList(generic)]);
      }
    } catch (error) {
      throw new ApiError(`ACCOUNT_POOL_JSON is not valid JSON: ${(error as Error).message}`, {
        status: 500,
        type: "server_error",
      });
    }
  }

  return pools;
}

export function tokensForPools(env: Env, candidates: PoolName[], exclude: Set<string> = new Set()): string[] {
  const pools = loadTokenPools(env);
  const tiered = unique(candidates.flatMap((pool) => pools[pool]));
  const selected = tiered.length > 0 ? tiered : pools.generic;
  return selected.filter((token) => token && !exclude.has(token));
}

export function hasAnyTokenForPools(env: Env, candidates: PoolName[]): boolean {
  return tokensForPools(env, candidates).length > 0;
}

export function retryCodes(env: Env): Set<number> {
  const raw = env.RETRY_ON_CODES || "429,401,503";
  return new Set(
    raw
      .split(",")
      .map((x) => Number.parseInt(x.trim(), 10))
      .filter((n) => Number.isFinite(n)),
  );
}

export function allowedOrigins(env: Env): string[] {
  const raw = env.ALLOWED_ORIGINS || "*";
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
