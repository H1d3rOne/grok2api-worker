import type { Env } from "./types";
import { ApiError } from "./errors";

export type ApiKeySource = "env" | "managed";

export interface PublicApiKey {
  id: string;
  source: ApiKeySource;
  label: string;
  masked: string;
  secret?: string;
  enabled: boolean;
  readonly: boolean;
  created_at?: number;
  updated_at?: number;
}

interface StoredApiKey {
  id: string;
  hash: string;
  masked: string;
  secret?: string;
  label?: string;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

interface ApiKeyStoreData {
  version: 1;
  keys: StoredApiKey[];
}

export interface AddApiKeyResult {
  key: PublicApiKey;
  secret?: string;
  generated: boolean;
}

export interface ApiKeyValidationResult {
  required: boolean;
  valid: boolean;
}

const STORE_KEY = "api-keys:v1";
const encoder = new TextEncoder();

export async function publicApiKeys(env: Env): Promise<PublicApiKey[]> {
  const envRows = envApiKeyRows(env);
  const store = await readStore(env);
  const managed = effectiveStoredApiKey(store.keys);
  const effective = managed ? publicManagedKey(managed) : envRows[0];
  return effective ? [effective] : [];
}

export function apiKeyCounts(keys: PublicApiKey[]): { total: number; enabled: number; disabled: number; env: number; managed: number } {
  return keys.reduce(
    (counts, key) => {
      counts.total += 1;
      if (key.enabled) counts.enabled += 1;
      else counts.disabled += 1;
      if (key.source === "env") counts.env += 1;
      else counts.managed += 1;
      return counts;
    },
    { total: 0, enabled: 0, disabled: 0, env: 0, managed: 0 },
  );
}

export async function addApiKey(env: Env, args: { key?: string; label?: string; enabled?: boolean }): Promise<AddApiKeyResult> {
  const store = await readStore(env);
  const provided = String(args.key || "").trim();
  const generated = !provided;
  const secret = generated ? generateApiKey() : provided;
  if (!secret) throw new ApiError("API key is required", { status: 400, type: "invalid_request_error", param: "key" });

  const now = nowSeconds();
  const hash = await hashSecret(secret);
  const id = apiKeyId(hash);
  const existing = store.keys.find((row) => row.id === id || timingSafeEqual(row.hash, hash)) || store.keys[0];
  const row: StoredApiKey = {
    id,
    hash,
    masked: maskApiKey(secret),
    secret,
    label: "",
    enabled: args.enabled ?? existing?.enabled ?? true,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  store.keys = [row];

  await writeStore(env, store);
  const publicRow = publicManagedKey(row);
  return { key: publicRow, secret, generated };
}

export async function updateApiKey(env: Env, id: string, patch: { enabled?: boolean; label?: string; key?: string }): Promise<PublicApiKey> {
  const store = await readStore(env);
  const row = store.keys.find((item) => item.id === id);
  if (!row) throw new ApiError("Managed API key not found", { status: 404, type: "invalid_request_error", code: "not_found" });
  if (patch.enabled !== undefined) row.enabled = !!patch.enabled;
  if (patch.label !== undefined) row.label = "";
  if (patch.key !== undefined) {
    const secret = String(patch.key || "").trim();
    if (!secret) throw new ApiError("API key is required", { status: 400, type: "invalid_request_error", param: "key" });
    const hash = await hashSecret(secret);
    row.id = apiKeyId(hash);
    row.hash = hash;
    row.masked = maskApiKey(secret);
    row.secret = secret;
  }
  row.label = "";
  row.updated_at = nowSeconds();
  store.keys = [row];
  await writeStore(env, store);
  return publicManagedKey(row);
}

export async function deleteApiKey(env: Env, id: string): Promise<void> {
  const store = await readStore(env);
  const before = store.keys.length;
  store.keys = store.keys.filter((row) => row.id !== id);
  if (store.keys.length === before) {
    throw new ApiError("Managed API key not found", { status: 404, type: "invalid_request_error", code: "not_found" });
  }
  await writeStore(env, store);
}

export async function validateApiKey(env: Env, token: string): Promise<ApiKeyValidationResult> {
  const envKeys = parseApiKeys(env.API_KEY);
  const store = await readStore(env);
  const managed = effectiveStoredApiKey(store.keys);
  const required = envKeys.length > 0 || !!managed;

  if (managed) {
    if (!token || !managed.enabled || !managed.hash) return { required, valid: false };
    const hash = await hashSecret(token);
    return { required, valid: timingSafeEqual(hash, managed.hash) };
  }

  const envKey = envKeys[0];
  if (!envKey) return { required: false, valid: false };
  return { required: true, valid: !!token && timingSafeEqual(token, envKey) };
}

export async function hasAnyApiKey(env: Env): Promise<boolean> {
  if (parseApiKeys(env.API_KEY).length > 0) return true;
  const store = await readStore(env);
  return store.keys.length > 0;
}

export function parseApiKeys(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  const text = String(raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return [...new Set(parsed.map((x) => String(x).trim()).filter(Boolean))];
  } catch {
    // fall back to CSV/newline parsing
  }
  return [
    ...new Set(
      text
        .split(/[,\n\r\t]+/g)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

async function readStore(env: Env): Promise<ApiKeyStoreData> {
  if (!env.TOKEN_STORE) return emptyStore();
  const raw = await env.TOKEN_STORE.get(STORE_KEY);
  if (!raw) return emptyStore();
  try {
    const parsed = JSON.parse(raw) as Partial<ApiKeyStoreData>;
    return {
      version: 1,
      keys: Array.isArray(parsed.keys) ? parsed.keys.filter(isStoredApiKey).map(normalizeStoredApiKey) : [],
    };
  } catch {
    return emptyStore();
  }
}

async function writeStore(env: Env, store: ApiKeyStoreData): Promise<void> {
  if (!env.TOKEN_STORE) {
    throw new ApiError("TOKEN_STORE KV binding is not configured", { status: 501, type: "not_supported_error" });
  }
  await env.TOKEN_STORE.put(STORE_KEY, JSON.stringify(store));
}

function emptyStore(): ApiKeyStoreData {
  return { version: 1, keys: [] };
}

function envApiKeyRows(env: Env): PublicApiKey[] {
  return parseApiKeys(env.API_KEY).slice(0, 1).map((key, index) => ({
    id: `env_${index + 1}_${fnv1a(key)}`,
    source: "env",
    label: "",
    masked: maskApiKey(key),
    secret: key,
    enabled: true,
    readonly: true,
  }));
}

function effectiveStoredApiKey(keys: StoredApiKey[]): StoredApiKey | undefined {
  const rows = keys.slice().sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
  return rows.find((row) => !!row.secret) || rows[0];
}

function publicManagedKey(row: StoredApiKey): PublicApiKey {
  return {
    id: row.id,
    source: "managed",
    label: "",
    masked: row.masked || "sk-…",
    secret: row.secret || undefined,
    enabled: row.enabled !== false,
    readonly: false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeStoredApiKey(row: StoredApiKey): StoredApiKey {
  const hash = String(row.hash || "").trim().toLowerCase();
  return {
    id: String(row.id || apiKeyId(hash)).trim(),
    hash,
    masked: String(row.masked || "sk-…").trim(),
    secret: typeof row.secret === "string" ? row.secret.trim() : undefined,
    label: "",
    enabled: row.enabled !== false,
    created_at: Number(row.created_at || nowSeconds()),
    updated_at: Number(row.updated_at || nowSeconds()),
  };
}

function isStoredApiKey(value: unknown): value is StoredApiKey {
  return !!value && typeof value === "object" && typeof (value as StoredApiKey).hash === "string" && !!(value as StoredApiKey).hash.trim();
}

async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function generateApiKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `sk-${Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function apiKeyId(hash: string): string {
  return `key_${String(hash || "").slice(0, 18) || fnv1a(String(Date.now()))}`;
}

function maskApiKey(key: string): string {
  const clean = String(key || "").trim();
  if (!clean) return "sk-…";
  if (clean.length <= 12) return `${clean.slice(0, 3)}…${clean.slice(-2)}`;
  return `${clean.slice(0, 7)}…${clean.slice(-4)}`;
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const max = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < max; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
