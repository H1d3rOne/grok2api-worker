import type { Env } from "./types";
import type { PoolName, TokenPools } from "./config";
import { loadTokenPools as loadEnvTokenPools, normalizeToken } from "./config";
import { ApiError, UpstreamError } from "./errors";

export type ManagedPoolName = "generic" | PoolName;
export type TokenSource = "env" | "managed";

export interface TokenAccount {
  id: string;
  token: string;
  pool: ManagedPoolName;
  source: TokenSource;
  label: string;
  enabled: boolean;
  created_at?: number;
  updated_at?: number;
  last_used_at?: number;
  last_error?: string;
  fail_count?: number;
  auto_disabled_reason?: string;
}

interface StoredToken {
  id: string;
  token: string;
  pool: ManagedPoolName;
  label?: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  last_used_at?: number;
  last_error?: string;
  fail_count?: number;
  auto_disabled_reason?: string;
}

interface TokenOverride {
  label?: string;
  enabled?: boolean;
  deleted?: boolean;
  last_used_at?: number;
  last_error?: string;
  fail_count?: number;
  auto_disabled_reason?: string;
  updated_at?: number;
}

interface TokenStoreData {
  version: 1;
  tokens: StoredToken[];
  overrides: Record<string, TokenOverride>;
}

export interface PublicTokenAccount {
  id: string;
  pool: ManagedPoolName;
  source: TokenSource;
  label: string;
  masked: string;
  enabled: boolean;
  created_at?: number;
  updated_at?: number;
  last_used_at?: number;
  last_error?: string;
  fail_count: number;
  auto_disabled_reason?: string;
}

const STORE_KEY = "token-pool:v1";
const POOLS: ManagedPoolName[] = ["generic", "basic", "super", "heavy"];

export async function loadTokenAccounts(env: Env): Promise<TokenAccount[]> {
  const store = await readStore(env);
  const rows: TokenAccount[] = [];
  const seen = new Set<string>();

  for (const token of envTokenRows(env)) {
    const override = store.overrides[token.id] || {};
    if (override.deleted) continue;
    const row: TokenAccount = {
      ...token,
      label: override.label ?? token.label,
      enabled: override.enabled ?? token.enabled,
      updated_at: override.updated_at,
      last_used_at: override.last_used_at,
      last_error: override.last_error,
      fail_count: override.fail_count,
      auto_disabled_reason: override.auto_disabled_reason,
    };
    rows.push(row);
    seen.add(row.id);
  }

  for (const token of store.tokens) {
    if (!token.token || seen.has(token.id)) continue;
    rows.push({
      id: token.id,
      token: normalizeToken(token.token),
      pool: normalizePool(token.pool),
      source: "managed",
      label: token.label || "Managed token",
      enabled: token.enabled,
      created_at: token.created_at,
      updated_at: token.updated_at,
      last_used_at: token.last_used_at,
      last_error: token.last_error,
      fail_count: token.fail_count,
      auto_disabled_reason: token.auto_disabled_reason,
    });
  }

  return rows;
}

export async function publicTokenAccounts(env: Env): Promise<PublicTokenAccount[]> {
  return (await loadTokenAccounts(env)).map((token) => ({
    id: token.id,
    pool: token.pool,
    source: token.source,
    label: token.label,
    masked: maskToken(token.token),
    enabled: token.enabled,
    created_at: token.created_at,
    updated_at: token.updated_at,
    last_used_at: token.last_used_at,
    last_error: token.last_error,
    fail_count: token.fail_count || 0,
    auto_disabled_reason: token.auto_disabled_reason,
  }));
}

export async function loadRuntimeTokenPools(env: Env): Promise<TokenPools> {
  const rows = await loadTokenAccounts(env);
  const pools: TokenPools = { generic: [], basic: [], super: [], heavy: [] };
  for (const row of rows) {
    if (!row.enabled) continue;
    pools[row.pool].push(row.token);
  }
  for (const pool of POOLS) pools[pool] = unique(pools[pool]);
  return pools;
}

export async function tokensForPools(env: Env, candidates: PoolName[], exclude: Set<string> = new Set()): Promise<TokenAccount[]> {
  const rows = (await loadTokenAccounts(env)).filter((row) => row.enabled && row.token && !exclude.has(row.token));
  const tiered = rows.filter((row) => row.pool !== "generic" && candidates.includes(row.pool as PoolName));
  const selected = tiered.length > 0 ? tiered : rows.filter((row) => row.pool === "generic");
  return uniqueByToken(selected);
}

export async function hasAnyTokenForPools(env: Env, candidates: PoolName[]): Promise<boolean> {
  return (await tokensForPools(env, candidates)).length > 0;
}

export async function countTokensForPools(env: Env, candidates: PoolName[], exclude: Set<string> = new Set()): Promise<number> {
  const rows = (await loadTokenAccounts(env)).filter((row) => {
    if (!row.enabled || !row.token || exclude.has(row.token)) return false;
    return row.pool === "generic" || candidates.includes(row.pool as PoolName);
  });
  return uniqueByToken(rows).length;
}

export async function addToken(env: Env, args: { token: string; pool?: string; label?: string; enabled?: boolean }): Promise<PublicTokenAccount> {
  const rows = await addTokens(env, { tokens: [args.token], pool: args.pool, label: args.label, enabled: args.enabled });
  const row = rows[0];
  if (!row) throw new ApiError("Token was saved but could not be reloaded", { status: 500, type: "server_error" });
  return row;
}

export async function addTokens(env: Env, args: { tokens: string[]; pool?: string; label?: string; enabled?: boolean }): Promise<PublicTokenAccount[]> {
  const store = await readStore(env);
  const tokens = unique((args.tokens || []).map((token) => normalizeToken(token)).filter(Boolean));
  if (!tokens.length) {
    throw new ApiError("token is required", { status: 400, type: "invalid_request_error", param: "token" });
  }
  const pool = normalizePool(args.pool || "generic");
  const now = nowSeconds();
  const label = cleanLabel(args.label);
  const ids: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const id = tokenId(token, pool, "managed");
    ids.push(id);
    const existing = store.tokens.find((row) => row.id === id);
    const itemLabel = label && tokens.length > 1 ? cleanLabel(`${label} ${i + 1}`) : label;
    if (existing) {
      existing.token = token;
      existing.pool = pool;
      if (itemLabel) existing.label = itemLabel;
      existing.enabled = args.enabled ?? existing.enabled;
      existing.updated_at = now;
      existing.auto_disabled_reason = undefined;
    } else {
      store.tokens.push({
        id,
        token,
        pool,
        label: itemLabel || `${pool} token`,
        enabled: args.enabled ?? true,
        created_at: now,
        updated_at: now,
        fail_count: 0,
      });
    }
  }

  await writeStore(env, store);
  const publicRows = await publicTokenAccounts(env);
  const byId = new Map(publicRows.map((item) => [item.id, item]));
  return ids.map((id) => byId.get(id)).filter((item): item is PublicTokenAccount => !!item);
}

export async function updateToken(
  env: Env,
  id: string,
  patch: { enabled?: boolean; label?: string; pool?: string },
): Promise<PublicTokenAccount> {
  const store = await readStore(env);
  const now = nowSeconds();
  const managed = store.tokens.find((row) => row.id === id);
  if (managed) {
    if (patch.enabled !== undefined) {
      managed.enabled = !!patch.enabled;
      if (managed.enabled) managed.auto_disabled_reason = undefined;
    }
    if (patch.label !== undefined) managed.label = cleanLabel(patch.label);
    if (patch.pool !== undefined) managed.pool = normalizePool(patch.pool);
    managed.updated_at = now;
    await writeStore(env, store);
  } else {
    const override = store.overrides[id] || {};
    if (patch.enabled !== undefined) {
      override.enabled = !!patch.enabled;
      if (override.enabled) override.auto_disabled_reason = undefined;
      override.deleted = false;
    }
    if (patch.label !== undefined) override.label = cleanLabel(patch.label);
    override.updated_at = now;
    store.overrides[id] = override;
    await writeStore(env, store);
  }
  const row = (await publicTokenAccounts(env)).find((item) => item.id === id);
  if (!row) throw new ApiError("Token not found", { status: 404, type: "invalid_request_error", code: "not_found" });
  return row;
}

export async function deleteToken(env: Env, id: string): Promise<void> {
  const store = await readStore(env);
  const before = store.tokens.length;
  store.tokens = store.tokens.filter((row) => row.id !== id);
  if (store.tokens.length === before) {
    store.overrides[id] = { ...(store.overrides[id] || {}), deleted: true, enabled: false, updated_at: nowSeconds() };
  }
  await writeStore(env, store);
}

export async function recordTokenSuccess(env: Env, id: string): Promise<void> {
  if (!env.TOKEN_STORE) return;
  await patchTokenMeta(env, id, {
    last_used_at: nowSeconds(),
    last_error: "",
    fail_count: 0,
    auto_disabled_reason: undefined,
  });
}

export async function recordTokenFailure(env: Env, id: string, error: unknown, options: { autoDisable?: boolean } = {}): Promise<void> {
  if (!env.TOKEN_STORE) return;
  const store = await readStore(env);
  const now = nowSeconds();
  const message = errorMessage(error).slice(0, 240);
  const managed = store.tokens.find((row) => row.id === id);
  if (managed) {
    managed.fail_count = (managed.fail_count || 0) + 1;
    managed.last_error = message;
    managed.updated_at = now;
    if (options.autoDisable) {
      managed.enabled = false;
      managed.auto_disabled_reason = message || "auto disabled after upstream auth failure";
    }
  } else {
    const override = store.overrides[id] || {};
    override.fail_count = (override.fail_count || 0) + 1;
    override.last_error = message;
    override.updated_at = now;
    if (options.autoDisable) {
      override.enabled = false;
      override.deleted = false;
      override.auto_disabled_reason = message || "auto disabled after upstream auth failure";
    }
    store.overrides[id] = override;
  }
  await writeStore(env, store);
}

export function isTokenFailure(error: unknown): boolean {
  if (!(error instanceof UpstreamError)) return false;
  return error.status === 401 || error.status === 403;
}

export function tokenCounts(tokens: PublicTokenAccount[]): Record<ManagedPoolName, { total: number; enabled: number; disabled: number }> {
  const counts: Record<ManagedPoolName, { total: number; enabled: number; disabled: number }> = {
    generic: { total: 0, enabled: 0, disabled: 0 },
    basic: { total: 0, enabled: 0, disabled: 0 },
    super: { total: 0, enabled: 0, disabled: 0 },
    heavy: { total: 0, enabled: 0, disabled: 0 },
  };
  for (const token of tokens) {
    counts[token.pool].total += 1;
    if (token.enabled) counts[token.pool].enabled += 1;
    else counts[token.pool].disabled += 1;
  }
  return counts;
}

async function patchTokenMeta(env: Env, id: string, patch: TokenOverride): Promise<void> {
  const store = await readStore(env);
  const managed = store.tokens.find((row) => row.id === id);
  const now = nowSeconds();
  if (managed) {
    if (patch.last_used_at !== undefined) managed.last_used_at = patch.last_used_at;
    if (patch.last_error !== undefined) managed.last_error = patch.last_error;
    if (patch.fail_count !== undefined) managed.fail_count = patch.fail_count;
    if (patch.auto_disabled_reason !== undefined) managed.auto_disabled_reason = patch.auto_disabled_reason;
    managed.updated_at = now;
  } else {
    store.overrides[id] = { ...(store.overrides[id] || {}), ...patch, updated_at: now };
  }
  await writeStore(env, store);
}

async function readStore(env: Env): Promise<TokenStoreData> {
  if (!env.TOKEN_STORE) return emptyStore();
  const raw = await env.TOKEN_STORE.get(STORE_KEY);
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as Partial<TokenStoreData>;
    return {
      version: 1,
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens.filter(isStoredToken).map(normalizeStoredToken) : [],
      overrides: parsed.overrides && typeof parsed.overrides === "object" ? (parsed.overrides as Record<string, TokenOverride>) : {},
    };
  } catch {
    return emptyStore();
  }
}

async function writeStore(env: Env, store: TokenStoreData): Promise<void> {
  if (!env.TOKEN_STORE) {
    throw new ApiError("TOKEN_STORE KV binding is not configured", { status: 501, type: "not_supported_error" });
  }
  await env.TOKEN_STORE.put(STORE_KEY, JSON.stringify(store));
}

function emptyStore(): TokenStoreData {
  return { version: 1, tokens: [], overrides: {} };
}

function envTokenRows(env: Env): TokenAccount[] {
  const pools = loadEnvTokenPools(env);
  const rows: TokenAccount[] = [];
  for (const pool of POOLS) {
    for (const token of pools[pool]) {
      rows.push({
        id: tokenId(token, pool, "env"),
        token,
        pool,
        source: "env",
        label: `${pool} env token`,
        enabled: true,
      });
    }
  }

  return rows;
}

function tokenId(token: string, pool: ManagedPoolName, source: TokenSource): string {
  return `${source}_${pool}_${fnv1a(`${pool}:${token}`)}`;
}

function normalizePool(value: unknown): ManagedPoolName {
  const pool = String(value || "generic").trim().toLowerCase();
  return POOLS.includes(pool as ManagedPoolName) ? (pool as ManagedPoolName) : "generic";
}

function normalizeStoredToken(token: StoredToken): StoredToken {
  const clean = normalizeToken(token.token);
  const pool = normalizePool(token.pool);
  const source: TokenSource = "managed";
  return {
    ...token,
    id: token.id || tokenId(clean, pool, source),
    token: clean,
    pool,
    label: cleanLabel(token.label || `${pool} token`),
    enabled: token.enabled !== false,
    created_at: Number(token.created_at || nowSeconds()),
    updated_at: Number(token.updated_at || nowSeconds()),
  };
}

function isStoredToken(value: unknown): value is StoredToken {
  return !!value && typeof value === "object" && typeof (value as StoredToken).token === "string";
}

function maskToken(token: string): string {
  const clean = normalizeToken(token);
  if (clean.length <= 12) return `${clean.slice(0, 3)}…${clean.slice(-2)}`;
  return `${clean.slice(0, 6)}…${clean.slice(-5)}`;
}

function cleanLabel(label: unknown): string {
  return String(label || "").trim().slice(0, 80);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function uniqueByToken(rows: TokenAccount[]): TokenAccount[] {
  const seen = new Set<string>();
  const out: TokenAccount[] = [];
  for (const row of rows) {
    if (seen.has(row.token)) continue;
    seen.add(row.token);
    out.push(row);
  }
  return out;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "");
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
