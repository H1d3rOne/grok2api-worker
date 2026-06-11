import type { Env } from "./types";
import { allowedOrigins, boolEnv } from "./config";
import { ApiError, errorResponse, jsonResponse } from "./errors";
import { listAvailableModels, supportedReasoningEfforts, type ModelSpec } from "./models";
import { addToken, addTokens, deleteToken, publicTokenAccounts, tokenCounts, updateToken } from "./token-pool";
import {
  addApiKey,
  apiKeyCounts,
  deleteApiKey,
  hasAnyApiKey,
  parseApiKeys,
  publicApiKeys,
  updateApiKey,
  validateApiKey,
} from "./api-keys";
import { handleAnthropicMessages } from "./anthropic/messages";
import { handleChatCompletions } from "./openai/chat";
import { handleImageGenerations } from "./openai/images";
import { handleResponses } from "./openai/responses";
import { nowSeconds } from "./openai/format";
import { adminPage } from "./admin";

const ALLOWED_METHODS = "GET,POST,PATCH,DELETE,OPTIONS";
const ALLOWED_HEADERS = "authorization,content-type,x-api-key,x-admin-key,openai-beta,anthropic-version,anthropic-dangerous-direct-browser-access";
const EXPOSE_HEADERS = "content-type,request-id,x-request-id";
const encoder = new TextEncoder();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = buildCorsHeaders(request, env);

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const response = await route(request, env, normalizePath(url.pathname));
      return withCors(response, corsHeaders);
    } catch (error) {
      return errorResponse(error, corsHeaders);
    }
  },
};

async function route(request: Request, env: Env, path: string): Promise<Response> {
  if (path === "/" && request.method === "GET") return rootResponse(env);
  if ((path === "/admin" || path === "/ui") && request.method === "GET") return adminPage();
  if (path === "/health" && request.method === "GET") return healthResponse(env);

  if (path.startsWith("/admin/api/")) {
    authenticateAdmin(request, env);
  } else if (path.startsWith("/v1/")) {
    await authenticate(request, env);
  }

  if (path === "/admin/api/models" && request.method === "GET") return listModelsResponse(env);
  if (path === "/admin/api/chat/completions" && request.method === "POST") return handleChatCompletions(request, env);

  if (path === "/admin/api/tokens" && request.method === "GET") return adminTokensResponse(env);
  if (path === "/admin/api/tokens" && request.method === "POST") return adminAddToken(request, env);
  if (path.startsWith("/admin/api/tokens/") && request.method === "PATCH") {
    const id = decodeURIComponent(path.slice("/admin/api/tokens/".length));
    return adminUpdateToken(request, env, id);
  }
  if (path.startsWith("/admin/api/tokens/") && request.method === "DELETE") {
    const id = decodeURIComponent(path.slice("/admin/api/tokens/".length));
    return adminDeleteToken(env, id);
  }

  if (path === "/admin/api/api-keys" && request.method === "GET") return adminApiKeysResponse(env);
  if (path === "/admin/api/api-keys" && request.method === "POST") return adminAddApiKey(request, env);
  if (path.startsWith("/admin/api/api-keys/") && request.method === "PATCH") {
    const id = decodeURIComponent(path.slice("/admin/api/api-keys/".length));
    return adminUpdateApiKey(request, env, id);
  }
  if (path.startsWith("/admin/api/api-keys/") && request.method === "DELETE") {
    const id = decodeURIComponent(path.slice("/admin/api/api-keys/".length));
    return adminDeleteApiKey(env, id);
  }

  if (path === "/v1/models" && request.method === "GET") return listModelsResponse(env);
  if (path.startsWith("/v1/models/") && request.method === "GET") {
    const modelId = decodeURIComponent(path.slice("/v1/models/".length));
    return getModelResponse(env, modelId);
  }

  if (path === "/v1/chat/completions" && request.method === "POST") return handleChatCompletions(request, env);
  if ((path === "/v1/responses" || path === "/v1/response") && request.method === "POST") return handleResponses(request, env);
  if (path === "/v1/messages" && request.method === "POST") return handleAnthropicMessages(request, env);
  if (path === "/v1/images/generations" && request.method === "POST") return handleImageGenerations(request, env);

  const allowed = allowedMethodsFor(path);
  if (allowed) {
    return jsonResponse(
      {
        error: {
          message: `Method ${request.method} not allowed for ${path}`,
          type: "invalid_request_error",
          code: "method_not_allowed",
          param: null,
        },
      },
      405,
      { allow: allowed },
    );
  }

  throw new ApiError(`Route ${path} not found`, {
    status: 404,
    type: "invalid_request_error",
    code: "not_found",
  });
}

async function rootResponse(env: Env): Promise<Response> {
  return jsonResponse({
    name: "grok2api-worker",
    object: "service",
    status: "ok",
    endpoints: [
      "GET /admin",
      "GET /health",
      "GET /v1/models",
      "GET /v1/models/{model}",
      "POST /v1/chat/completions",
      "POST /v1/responses",
      "POST /v1/messages",
      "POST /v1/images/generations",
    ],
    auth_required: await hasAnyApiKey(env),
    admin_auth_required: true,
    admin_password_configured: parseAdminPasswords(env).length > 0,
  });
}

async function healthResponse(env: Env): Promise<Response> {
  const tokens = await publicTokenAccounts(env);
  const counts = tokenCounts(tokens);
  const models = await listAvailableModels(env);
  return jsonResponse({
    status: "ok",
    object: "health",
    time: nowSeconds(),
    auth_required: await hasAnyApiKey(env),
    admin_auth_required: true,
    admin_password_configured: parseAdminPasswords(env).length > 0,
    available_models: models.length,
    token_pools: {
      generic: counts.generic.enabled,
      basic: counts.basic.enabled,
      super: counts.super.enabled,
      heavy: counts.heavy.enabled,
    },
    token_pool_counts: {
      generic: counts.generic,
      basic: counts.basic,
      super: counts.super,
      heavy: counts.heavy,
    },
    features: {
      stream_default: false,
      thinking_default: boolEnv(env, "THINKING", true),
      console_models: boolEnv(env, "ENABLE_CONSOLE_MODELS", true),
      console_upstream: boolEnv(env, "USE_CONSOLE_UPSTREAM", true),
      app_chat_models: boolEnv(env, "ENABLE_APP_CHAT_MODELS", true),
      vpc_egress: boolEnv(env, "USE_VPC_EGRESS", false),
      vpc_egress_binding: !!env.EGRESS,
      console_web_search: boolEnv(env, "CONSOLE_WEB_SEARCH", true),
      expose_all_models: boolEnv(env, "WORKER_EXPOSE_ALL_MODELS", false),
    },
  });
}

async function adminApiKeysResponse(env: Env): Promise<Response> {
  const keys = await publicApiKeys(env);
  return jsonResponse({
    object: "api_key_pool",
    kv_configured: !!env.TOKEN_STORE,
    counts: apiKeyCounts(keys),
    data: keys,
  });
}

async function adminAddApiKey(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const result = await addApiKey(env, {
    key: typeof body.key === "string" ? body.key : "",
    label: typeof body.label === "string" ? body.label : "",
    enabled: body.enabled === undefined ? true : !!body.enabled,
  });
  const response: Record<string, unknown> = { object: "api_key", data: result.key, generated: result.generated };
  if (result.secret) response.secret = result.secret;
  return jsonResponse(response, 201);
}

async function adminUpdateApiKey(request: Request, env: Env, id: string): Promise<Response> {
  if (!id) throw new ApiError("API key id is required", { status: 400, type: "invalid_request_error", param: "id" });
  const body = await readJsonObject(request);
  const patch: { enabled?: boolean; label?: string; key?: string } = {};
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body.label !== undefined) patch.label = String(body.label || "");
  if (body.key !== undefined) patch.key = String(body.key || "");
  const key = await updateApiKey(env, id, patch);
  return jsonResponse({ object: "api_key", data: key });
}

async function adminDeleteApiKey(env: Env, id: string): Promise<Response> {
  if (!id) throw new ApiError("API key id is required", { status: 400, type: "invalid_request_error", param: "id" });
  await deleteApiKey(env, id);
  return jsonResponse({ object: "api_key.deleted", id, deleted: true });
}

async function listModelsResponse(env: Env): Promise<Response> {
  const data = (await listAvailableModels(env)).map(modelObject);
  return jsonResponse({ object: "list", data });
}

async function getModelResponse(env: Env, modelId: string): Promise<Response> {
  const spec = (await listAvailableModels(env)).find((m) => m.id === modelId);
  if (!spec) {
    throw new ApiError(`Model ${JSON.stringify(modelId)} not found`, {
      status: 404,
      type: "invalid_request_error",
      code: "model_not_found",
      param: "model",
    });
  }
  return jsonResponse(modelObject(spec));
}

function modelObject(spec: ModelSpec): Record<string, unknown> {
  return {
    id: spec.id,
    object: "model",
    created: nowSeconds(),
    owned_by: "xai",
    name: spec.id,
    reasoning_efforts: supportedReasoningEfforts(spec),
    default_reasoning_effort: spec.defaultReasoningEffort || null,
  };
}

async function adminTokensResponse(env: Env): Promise<Response> {
  const tokens = await publicTokenAccounts(env);
  return jsonResponse({
    object: "token_pool",
    kv_configured: !!env.TOKEN_STORE,
    counts: tokenCounts(tokens),
    data: tokens,
  });
}

async function adminAddToken(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  if (Array.isArray(body.tokens)) {
    const tokens = await addTokens(env, {
      tokens: body.tokens.map((token) => String(token || "")),
      pool: typeof body.pool === "string" ? body.pool : "generic",
      label: typeof body.label === "string" ? body.label : "",
      enabled: body.enabled === undefined ? true : !!body.enabled,
    });
    return jsonResponse({ object: "list", data: tokens }, 201);
  }
  const token = await addToken(env, {
    token: String(body.token || ""),
    pool: typeof body.pool === "string" ? body.pool : "generic",
    label: typeof body.label === "string" ? body.label : "",
    enabled: body.enabled === undefined ? true : !!body.enabled,
  });
  return jsonResponse({ object: "token", data: token }, 201);
}

async function adminUpdateToken(request: Request, env: Env, id: string): Promise<Response> {
  if (!id) throw new ApiError("token id is required", { status: 400, type: "invalid_request_error", param: "id" });
  const body = await readJsonObject(request);
  const patch: { enabled?: boolean; label?: string; pool?: string } = {};
  if (body.enabled !== undefined) patch.enabled = !!body.enabled;
  if (body.label !== undefined) patch.label = String(body.label || "");
  if (body.pool !== undefined) patch.pool = String(body.pool || "");
  const token = await updateToken(env, id, patch);
  return jsonResponse({ object: "token", data: token });
}

async function adminDeleteToken(env: Env, id: string): Promise<Response> {
  if (!id) throw new ApiError("token id is required", { status: 400, type: "invalid_request_error", param: "id" });
  await deleteToken(env, id);
  return jsonResponse({ object: "token.deleted", id, deleted: true });
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("Request body must be a JSON object", { status: 400, type: "invalid_request_error" });
  }
  return body as Record<string, unknown>;
}

function authenticateAdmin(request: Request, env: Env): void {
  const keys = parseAdminPasswords(env);
  if (!keys.length) {
    throw new ApiError("ADMIN_PASSWORD is not configured. Set it as a Cloudflare Worker secret before using /admin/api.", {
      status: 500,
      type: "server_error",
      code: "admin_password_not_configured",
    });
  }

  const token = extractBearer(request.headers.get("authorization")) || request.headers.get("x-admin-key") || "";
  if (!token) {
    throw new ApiError("Missing admin password.", {
      status: 401,
      type: "authentication_error",
      code: "missing_admin_password",
    });
  }

  if (!keys.some((key) => timingSafeEqual(token, key))) {
    throw new ApiError("Invalid admin password.", {
      status: 403,
      type: "authentication_error",
      code: "invalid_admin_password",
    });
  }
}

function parseAdminPasswords(env: Env): string[] {
  return parseApiKeys(env.ADMIN_PASSWORD);
}

async function authenticate(request: Request, env: Env): Promise<void> {
  const token = extractBearer(request.headers.get("authorization")) || request.headers.get("x-api-key") || "";
  const result = await validateApiKey(env, token);
  if (!result.required) return;
  if (!token) {
    throw new ApiError("Missing or invalid Authorization header.", {
      status: 401,
      type: "authentication_error",
      code: "missing_api_key",
    });
  }

  if (!result.valid) {
    throw new ApiError("Invalid API key.", {
      status: 403,
      type: "authentication_error",
      code: "invalid_api_key",
    });
  }
}

function extractBearer(authorization: string | null): string | null {
  if (!authorization) return null;
  const [scheme, ...rest] = authorization.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token || null;
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const max = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < max; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  return pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function allowedMethodsFor(path: string): string | null {
  if (path === "/" || path === "/admin" || path === "/ui" || path === "/health" || path === "/v1/models" || path.startsWith("/v1/models/")) return "GET,OPTIONS";
  if (path === "/admin/api/models") return "GET,OPTIONS";
  if (path === "/admin/api/chat/completions") return "POST,OPTIONS";
  if (path === "/admin/api/tokens") return "GET,POST,OPTIONS";
  if (path.startsWith("/admin/api/tokens/")) return "PATCH,DELETE,OPTIONS";
  if (path === "/admin/api/api-keys") return "GET,POST,OPTIONS";
  if (path.startsWith("/admin/api/api-keys/")) return "PATCH,DELETE,OPTIONS";
  if (
    path === "/v1/chat/completions" ||
    path === "/v1/responses" ||
    path === "/v1/response" ||
    path === "/v1/messages" ||
    path === "/v1/images/generations"
  )
    return "POST,OPTIONS";
  return null;
}

function buildCorsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  if (!boolEnv(env, "ENABLE_CORS", true)) return headers;

  const allowed = allowedOrigins(env);
  const origin = request.headers.get("origin");
  let allowOrigin = "*";
  if (!allowed.includes("*")) {
    if (origin && allowed.includes(origin)) allowOrigin = origin;
    else allowOrigin = allowed[0] || "";
  } else if (origin && request.headers.get("authorization")) {
    // Avoid wildcard + credentials ambiguity for browser clients that attach Authorization.
    allowOrigin = origin;
  }

  if (allowOrigin) headers.set("access-control-allow-origin", allowOrigin);
  if (allowOrigin !== "*") headers.set("vary", "Origin");
  headers.set("access-control-allow-methods", ALLOWED_METHODS);
  headers.set("access-control-allow-headers", request.headers.get("access-control-request-headers") || ALLOWED_HEADERS);
  headers.set("access-control-expose-headers", EXPOSE_HEADERS);
  headers.set("access-control-max-age", "86400");
  return headers;
}

function withCors(response: Response, corsHeaders: Headers): Response {
  if (!hasHeaders(corsHeaders)) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function hasHeaders(headers: Headers): boolean {
  for (const _ of headers) return true;
  return false;
}
