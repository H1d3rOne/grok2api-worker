import type { Env, ImageGenerationRequest } from "../types";
import { selectAccount, type SelectedAccount } from "../accounts";
import { ApiError, UpstreamError } from "../errors";
import { appChatModelsEnabled, type ModelSpec, getModel, poolCandidates } from "../models";
import { floatEnv, intEnv, retryCodes } from "../config";
import { countTokensForPools, isTokenFailure, recordTokenFailure, recordTokenSuccess } from "../token-pool";
import { buildChatPayload, classifyLine, postGrokChat, StreamAdapter } from "../xai/chat";
import { readLines } from "../xai/http";
import { bytesToBase64, downloadAsset } from "../xai/assets";
import { nowSeconds } from "./format";

export interface GeneratedImage {
  url: string;
  markdownUrl: string;
  b64Json?: string;
}

export async function handleImageGenerations(request: Request, env: Env): Promise<Response> {
  const req = (await request.json().catch(() => null)) as ImageGenerationRequest | null;
  if (!req || typeof req !== "object") throw new ApiError("Request body must be JSON", { status: 400, type: "invalid_request_error" });
  if (!req.model) throw new ApiError("model is required", { status: 400, type: "invalid_request_error", param: "model" });
  if (!req.prompt || typeof req.prompt !== "string") throw new ApiError("prompt is required", { status: 400, type: "invalid_request_error", param: "prompt" });
  const spec = getModel(req.model);
  if (!spec || spec.capability !== "image") {
    throw new ApiError(`Model ${JSON.stringify(req.model)} is not an image model`, { status: 400, type: "invalid_request_error", param: "model" });
  }
  if (!appChatModelsEnabled(env)) {
    throw new ApiError(`Model ${JSON.stringify(req.model)} is not available because app-chat upstream models are disabled.`, {
      status: 404,
      type: "invalid_request_error",
      code: "model_not_found",
      param: "model",
    });
  }
  if (spec.id !== "grok-imagine-image-lite") {
    throw new ApiError("Worker build currently supports /v1/images/generations only for grok-imagine-image-lite", {
      status: 501,
      type: "not_supported_error",
      param: "model",
    });
  }
  const n = req.n ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > 4) {
    throw new ApiError("n must be between 1 and 4 for grok-imagine-image-lite", { status: 400, type: "invalid_request_error", param: "n" });
  }
  const responseFormat = normalizeResponseFormat(req.response_format || "url");
  const images = await generateLiteImages(env, spec, req.prompt, n, responseFormat);
  return new Response(
    JSON.stringify({
      created: nowSeconds(),
      data: images.map((image) => (responseFormat === "b64_json" ? { b64_json: image.b64Json || "" } : { url: image.url })),
    }),
    { headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

export async function generateLiteImages(
  env: Env,
  spec: ModelSpec,
  prompt: string,
  n: number,
  responseFormat: string,
): Promise<GeneratedImage[]> {
  const fmt = normalizeResponseFormat(responseFormat);
  const count = Math.max(1, Math.min(spec.id === "grok-imagine-image-lite" ? 4 : 10, Math.trunc(n || 1)));
  const tasks = Array.from({ length: count }, () => runLiteRequest(env, spec, prompt, fmt));
  return Promise.all(tasks);
}

async function runLiteRequest(env: Env, spec: ModelSpec, prompt: string, responseFormat: string): Promise<GeneratedImage> {
  const maxRetries = Math.max(0, intEnv(env, "MAX_RETRIES", 1));
  const retry = retryCodes(env);
  const excluded = new Set<string>();
  const timeoutMs = Math.max(1, floatEnv(env, "CHAT_TIMEOUT_SECONDS", 120)) * 1000;
  const maxAttempts = await maxAttemptsFor(env, spec, maxRetries);
  let retryAttempts = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = await selectAccountOrThrow(env, spec, excluded, lastError);
    try {
      const payload = buildChatPayload(env, {
        message: `Drawing: ${prompt}`,
        modeId: spec.modeId,
        fileAttachments: [],
        requestOverrides: { imageGenerationCount: 2 },
      });
      const upstream = await postGrokChat(env, account.token, payload, timeoutMs);
      const adapter = new StreamAdapter(env);
      for await (const line of readLines(upstream.body)) {
        const [kind, data] = classifyLine(line);
        if (kind === "done") break;
        if (kind !== "data" || !data) continue;
        for (const ev of adapter.feed(data)) {
          if (ev.kind === "image" && ev.content) {
            if (responseFormat === "b64_json") {
              const { bytes } = await downloadAsset(env, account.token, ev.content);
              const b64 = bytesToBase64(bytes);
              await recordSuccessSafe(env, account);
              return { url: ev.content, markdownUrl: `data:image/jpeg;base64,${b64}`, b64Json: b64 };
            }
            await recordSuccessSafe(env, account);
            return { url: ev.content, markdownUrl: ev.content };
          }
        }
      }
      throw new UpstreamError("Image generation returned no images", 502);
    } catch (error) {
      lastError = error;
      const tokenFailure = isTokenFailure(error);
      await recordFailureSafe(env, account, error, tokenFailure);
      excluded.add(account.token);
      if (tokenFailure) {
        continue;
      }
      if (error instanceof UpstreamError && (retry.has(error.status) || error.status === 401) && retryAttempts < maxRetries) {
        retryAttempts++;
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new UpstreamError("Image generation failed", 502);
}

async function maxAttemptsFor(env: Env, spec: ModelSpec, maxRetries: number): Promise<number> {
  const tokenCount = await countTokensForPools(env, poolCandidates(spec)).catch(() => 1);
  return Math.max(1, tokenCount) + Math.max(0, maxRetries);
}

async function selectAccountOrThrow(env: Env, spec: ModelSpec, excluded: Set<string>, lastError?: unknown): Promise<SelectedAccount> {
  try {
    return await selectAccount(env, spec, excluded);
  } catch (error) {
    if (lastError) throw lastError;
    throw error;
  }
}

async function recordSuccessSafe(env: Env, account: SelectedAccount): Promise<void> {
  await recordTokenSuccess(env, account.tokenId).catch(() => undefined);
}

async function recordFailureSafe(env: Env, account: SelectedAccount, error: unknown, autoDisable: boolean): Promise<void> {
  await recordTokenFailure(env, account.tokenId, error, { autoDisable }).catch(() => undefined);
}

function normalizeResponseFormat(value: string): "url" | "b64_json" {
  const fmt = value.trim().toLowerCase();
  if (fmt !== "url" && fmt !== "b64_json") {
    throw new ApiError("response_format must be one of ['url', 'b64_json']", { status: 400, type: "invalid_request_error", param: "response_format" });
  }
  return fmt;
}
