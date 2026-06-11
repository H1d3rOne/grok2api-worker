import type { Env } from "../types";
import { boolEnv } from "../config";
import { ApiError, UpstreamError } from "../errors";

type FetcherLike = Pick<Fetcher, "fetch">;

function upstreamFetcher(env?: Env): FetcherLike {
  if (!env || !boolEnv(env, "USE_VPC_EGRESS", false)) return globalThis;
  if (env.EGRESS && typeof env.EGRESS.fetch === "function") return env.EGRESS;
  throw new ApiError("USE_VPC_EGRESS=true but EGRESS VPC network binding is not configured", {
    status: 500,
    type: "server_error",
  });
}

export async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 120_000, env?: Env): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`timeout after ${timeoutMs}ms`), timeoutMs);
  try {
    return await upstreamFetcher(env).fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && /abort|timeout/i.test(error.message)) {
      throw new UpstreamError(`Upstream request timed out: ${url}`, 504);
    }
    throw new UpstreamError(`Upstream transport failed: ${(error as Error).message || String(error)}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function assertOk(response: Response, label: string): Promise<Response> {
  if (response.ok) return response;
  const body = await response.text().catch(() => "");
  throw new UpstreamError(`${label} returned ${response.status}`, response.status, body.slice(0, 500));
}

export async function* readLines(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, idx);
        const nl = buffer[idx] === "\r" && buffer[idx + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(idx + nl);
        yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}
