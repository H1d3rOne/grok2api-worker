import type { Env } from "../types";
import { ApiError, UpstreamError } from "../errors";
import { floatEnv } from "../config";
import { buildHttpHeaders, buildSsoCookie } from "./headers";
import { assertOk, fetchWithTimeout } from "./http";

const UPLOAD_URL = "https://grok.com/rest/app-chat/upload-file";
const ASSETS_BASE = "https://assets.grok.com";
const X_USER_ID_RE = /(?:^|;\s*)x-userid=([^;]+)/;

export async function uploadFromInput(env: Env, token: string, fileInput: string): Promise<string> {
  const parsed = await resolveFileInput(env, token, fileInput);
  const timeoutMs = Math.max(1, floatEnv(env, "ASSET_UPLOAD_TIMEOUT_SECONDS", 60)) * 1000;
  const response = await fetchWithTimeout(
    UPLOAD_URL,
    {
      method: "POST",
      headers: buildHttpHeaders(token, env, { contentType: "application/json" }),
      body: JSON.stringify({
        fileName: parsed.filename,
        fileMimeType: parsed.mime,
        content: parsed.base64,
      }),
    },
    timeoutMs,
    env,
  );
  await assertOk(response, "Asset upload upstream");
  const obj = (await response.json()) as Record<string, unknown>;
  const fileId = String(obj.fileMetadataId || obj.fileId || "");
  if (!fileId) throw new UpstreamError("Asset upload returned no file id", 502, JSON.stringify(obj).slice(0, 300));
  return fileId;
}

export async function downloadAsset(env: Env, token: string, url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const timeoutMs = Math.max(1, floatEnv(env, "ASSET_DOWNLOAD_TIMEOUT_SECONDS", 120)) * 1000;
  const response = await fetchWithTimeout(
    url,
    {
      headers: buildHttpHeaders(token, env, {
        contentType: null,
        origin: originForUrl(url),
        referer: `${originForUrl(url)}/`,
        accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      }),
    },
    timeoutMs,
    env,
  );
  await assertOk(response, "Asset download upstream");
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || inferContentType(url) || "application/octet-stream";
  return { bytes, contentType };
}

async function resolveFileInput(env: Env, token: string, fileInput: string): Promise<{ filename: string; mime: string; base64: string }> {
  const value = fileInput.trim();
  if (isUrl(value)) {
    const timeoutMs = Math.max(1, floatEnv(env, "ASSET_DOWNLOAD_TIMEOUT_SECONDS", 60)) * 1000;
    const response = await fetchWithTimeout(
      value,
      {
        headers: buildHttpHeaders(token, env, {
          contentType: null,
          origin: originForUrl(value),
          referer: `${originForUrl(value)}/`,
          accept: "*/*",
        }),
      },
      timeoutMs,
      env,
    );
    await assertOk(response, "Input file fetch");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || inferContentType(value) || "application/octet-stream";
    const pathname = new URL(value).pathname;
    const filename = pathname.split("/").filter(Boolean).pop() || `file.${extensionFromMime(mime)}`;
    return { filename, mime, base64: bytesToBase64(bytes) };
  }

  if (!value.startsWith("data:")) {
    throw new ApiError("File input must be an http(s) URL or a base64 data URI", {
      status: 400,
      type: "invalid_request_error",
      param: "content",
    });
  }
  const comma = value.indexOf(",");
  if (comma < 0) {
    throw new ApiError("Malformed data URI: missing comma separator", { status: 400, type: "invalid_request_error" });
  }
  const header = value.slice(5, comma);
  const body = value.slice(comma + 1).replace(/\s+/g, "");
  if (!/;base64(?:;|$)/i.test(header)) {
    throw new ApiError("Data URI must be base64-encoded", { status: 400, type: "invalid_request_error" });
  }
  const mime = header.split(";")[0] || "application/octet-stream";
  if (!body) throw new ApiError("Data URI has empty payload", { status: 400, type: "invalid_request_error" });
  return { filename: `file.${extensionFromMime(mime)}`, mime, base64: body };
}

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function originForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return ASSETS_BASE;
  }
}

export function inferContentType(url: string): string | undefined {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // keep as-is
  }
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  return undefined;
}

function extensionFromMime(mime: string): string {
  const clean = mime.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
  if (clean === "image/jpeg") return "jpg";
  if (clean === "image/png") return "png";
  if (clean === "image/webp") return "webp";
  if (clean === "image/gif") return "gif";
  if (clean === "video/mp4") return "mp4";
  if (clean === "video/webm") return "webm";
  return clean.includes("/") ? clean.split("/").pop() || "bin" : "bin";
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function extractUserIdFromCookie(token: string, env: Env): string | undefined {
  const match = buildSsoCookie(token, env).match(X_USER_ID_RE);
  return match?.[1];
}
