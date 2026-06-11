import type { ChatCompletionRequest, ChatMessage, Env } from "../types";
import { selectAccount, type SelectedAccount } from "../accounts";
import { boolEnv, floatEnv, intEnv, retryCodes } from "../config";
import { ApiError, normalizeError, UpstreamError } from "../errors";
import {
  REASONING_EFFORTS,
  appChatFallbackSpec,
  assertReasoningEffortSupported,
  getModel,
  isRuntimeAvailableModel,
  isWorkerSupportedModel,
  poolCandidates,
  type ModelSpec,
  useConsoleUpstream,
} from "../models";
import { countTokensForPools, isTokenFailure, recordTokenFailure, recordTokenSuccess } from "../token-pool";
import { uploadFromInput, downloadAsset, bytesToBase64 } from "../xai/assets";
import { buildChatPayload, classifyLine, postGrokChat, StreamAdapter, type UrlCitation } from "../xai/chat";
import { readLines } from "../xai/http";
import {
  buildToolSystemPrompt,
  extractToolNames,
  injectIntoMessage,
  parsedToolCallsToOpenAI,
  parseToolCalls,
  ToolSieve,
  toolCallsToXml,
} from "../xai/tools";
import {
  buildConsoleInput,
  classifyConsoleSseLine,
  ConsoleStreamAdapter,
  convertOpenAIToolChoice,
  convertOpenAIToolsToConsole,
  extractConsoleAnnotations,
  extractConsoleReasoning,
  extractConsoleSearchSources,
  extractConsoleText,
  extractConsoleToolCalls,
  extractConsoleUsage,
  injectWebSearchTool,
  postConsole,
} from "../xai/console";
import {
  buildUsage,
  estimateTokens,
  makeChatResponse,
  makeResponseId,
  makeStreamChunk,
  makeThinkingChunk,
  makeToolCallChunk,
  makeToolCallDoneChunk,
  makeToolCallResponse,
  sseData,
} from "./format";

const encoder = new TextEncoder();
const VALID_ROLES = new Set(["developer", "system", "user", "assistant", "tool"]);
const EFFORT_VALUES: Set<string> = new Set(REASONING_EFFORTS);

export async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  const req = (await request.json().catch(() => null)) as ChatCompletionRequest | null;
  if (!req || typeof req !== "object") throw new ApiError("Request body must be JSON", { status: 400, type: "invalid_request_error" });
  validateChatRequest(req);

  const spec = getModel(req.model);
  if (!spec || !spec.enabled) {
    throw new ApiError(`Model ${JSON.stringify(req.model)} does not exist or you do not have access to it.`, {
      status: 404,
      type: "invalid_request_error",
      code: "model_not_found",
      param: "model",
    });
  }
  if (!isWorkerSupportedModel(spec)) {
    throw new ApiError(`Model ${req.model} is registered in grok2api but is not implemented in the Worker build yet.`, {
      status: 501,
      type: "not_supported_error",
      param: "model",
    });
  }
  if (!(await isRuntimeAvailableModel(env, spec))) {
    throw new ApiError(`Model ${JSON.stringify(req.model)} is not available in the current Worker upstream configuration.`, {
      status: 404,
      type: "invalid_request_error",
      code: "model_not_found",
      param: "model",
    });
  }

  const isStream = req.stream === true;
  const emitThink = req.reasoning_effort === undefined || req.reasoning_effort === null ? boolEnv(env, "THINKING", true) : req.reasoning_effort !== "none";

  let runtimeSpec = spec;
  if (spec.consoleModel && useConsoleUpstream(env)) {
    if (!boolEnv(env, "ENABLE_CONSOLE_MODELS", true)) {
      throw new ApiError("Console models are disabled by ENABLE_CONSOLE_MODELS=false", { status: 501, type: "not_supported_error" });
    }
    assertReasoningEffortSupported(spec, req.reasoning_effort ?? spec.defaultReasoningEffort ?? null);
    return consoleChat(req, spec, env, isStream, emitThink);
  } else if (spec.consoleModel) {
    runtimeSpec = appChatFallbackSpec(spec);
  }

  assertReasoningEffortSupported(runtimeSpec, req.reasoning_effort ?? runtimeSpec.defaultReasoningEffort ?? null);

  if (runtimeSpec.capability === "image") {
    if (runtimeSpec.id !== "grok-imagine-image-lite") {
      throw new ApiError("Only grok-imagine-image-lite is supported by the Worker image path; WS imagine models are not ported.", {
        status: 501,
        type: "not_supported_error",
        param: "model",
      });
    }
    const prompt = extractLastUserText(req.messages) || extractMessage(req.messages).message;
    const n = req.image_config?.n || 1;
    const responseFormat = req.image_config?.response_format || "url";
    const { generateLiteImages } = await import("./images");
    if (isStream) {
      const responseId = makeResponseId();
      return sseResponse(async (write) => {
        const images = await generateLiteImages(env, runtimeSpec, prompt, n, responseFormat);
        for (const image of images) {
          await write(sseData(makeStreamChunk(responseId, runtimeSpec.id, `![image](${image.url})`)));
        }
        await write(sseData(makeStreamChunk(responseId, runtimeSpec.id, "", { isFinal: true })));
        await write("data: [DONE]\n\n");
      });
    }
    const images = await generateLiteImages(env, runtimeSpec, prompt, n, responseFormat);
    return json(makeChatResponse(runtimeSpec.id, images.map((img) => `![image](${img.markdownUrl || img.url})`).join("\n\n"), { promptContent: prompt }));
  }

  return isStream ? legacyChatStream(req, runtimeSpec, env, emitThink) : json(await legacyChatNonStream(req, runtimeSpec, env, emitThink));
}

function validateChatRequest(req: ChatCompletionRequest): void {
  if (!req.model || typeof req.model !== "string") {
    throw new ApiError("model is required", { status: 400, type: "invalid_request_error", param: "model" });
  }
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new ApiError("messages cannot be empty", { status: 400, type: "invalid_request_error", param: "messages" });
  }
  req.messages.forEach((msg, i) => {
    if (!VALID_ROLES.has(String(msg.role))) {
      throw new ApiError(`role must be one of ${JSON.stringify([...VALID_ROLES])}`, {
        status: 400,
        type: "invalid_request_error",
        param: `messages.${i}.role`,
      });
    }
  });
  if (req.temperature !== undefined && req.temperature !== null && (req.temperature < 0 || req.temperature > 2)) {
    throw new ApiError("temperature must be between 0 and 2", { status: 400, type: "invalid_request_error", param: "temperature" });
  }
  if (req.top_p !== undefined && req.top_p !== null && (req.top_p < 0 || req.top_p > 1)) {
    throw new ApiError("top_p must be between 0 and 1", { status: 400, type: "invalid_request_error", param: "top_p" });
  }
  if (req.reasoning_effort && !EFFORT_VALUES.has(req.reasoning_effort)) {
    throw new ApiError(`reasoning_effort must be one of ${JSON.stringify([...EFFORT_VALUES])}`, {
      status: 400,
      type: "invalid_request_error",
      param: "reasoning_effort",
    });
  }
}

async function legacyChatNonStream(req: ChatCompletionRequest, spec: ModelSpec, env: Env, emitThink: boolean): Promise<Record<string, unknown>> {
  let { message, files } = extractMessage(req.messages);
  if (!message.trim()) throw new ApiError("Empty message after extraction", { status: 400, type: "invalid_request_error" });
  const toolNames = extractToolNames(req.tools || []);
  if (toolNames.length) message = injectIntoMessage(message, buildToolSystemPrompt(req.tools || [], req.tool_choice));

  const maxRetries = Math.max(0, intEnv(env, "MAX_RETRIES", 1));
  const retry = retryCodes(env);
  const excluded = new Set<string>();
  const responseId = makeResponseId();
  const timeoutMs = Math.max(1, floatEnv(env, "CHAT_TIMEOUT_SECONDS", 120)) * 1000;
  const maxAttempts = await maxAttemptsFor(env, spec, maxRetries);
  let retryAttempts = 0;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = await selectAccountOrThrow(env, spec, excluded, lastError);
    const adapter = new StreamAdapter(env);
    try {
      const attachments = await prepareFileAttachments(env, account.token, files);
      const payload = buildChatPayload(env, {
        message,
        modeId: spec.modeId,
        fileAttachments: attachments,
      });
      const upstream = await postGrokChat(env, account.token, payload, timeoutMs);
      for await (const line of readLines(upstream.body)) {
        const [kind, data] = classifyLine(line);
        if (kind === "done") break;
        if (kind !== "data" || !data) continue;
        let ended = false;
        for (const ev of adapter.feed(data)) {
          if (ev.kind === "soft_stop") {
            ended = true;
            break;
          }
        }
        if (ended) break;
      }

      let fullText = adapter.textBuf.join("");
      for (const image of adapter.imageUrls) {
        const text = await resolveImageText(env, account.token, image.url, image.imageId);
        fullText += fullText ? `\n\n${text}` : text;
      }
      const refs = adapter.referencesSuffix();
      if (refs) fullText += refs;
      const thinking = emitThink ? adapter.thinkingBuf.join("") || null : null;
      const annotations = toChatAnnotations(adapter.annotationsList());
      if (toolNames.length) {
        const parsed = parseToolCalls(fullText, toolNames);
        if (parsed.calls.length) {
          const resp = makeToolCallResponse(spec.id, parsedToolCallsToOpenAI(parsed.calls), {
            promptContent: message,
            responseId,
          });
          const sources = adapter.searchSourcesList();
          if (sources?.length) resp.search_sources = sources;
          await recordSuccessSafe(env, account);
          return resp;
        }
      }
      const response = makeChatResponse(spec.id, fullText, {
        promptContent: message,
        responseId,
        reasoningContent: thinking,
        annotations,
        searchSources: adapter.searchSourcesList() || null,
      });
      await recordSuccessSafe(env, account);
      return response;
    } catch (error) {
      lastError = error;
      const tokenFailure = isTokenFailure(error);
      await recordFailureSafe(env, account, error, tokenFailure);
      excluded.add(account.token);
      if (tokenFailure) continue;
      if (shouldRetry(error, retry) && retryAttempts < maxRetries) {
        retryAttempts++;
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new ApiError("Chat request failed", { status: 500, type: "server_error" });
}

function legacyChatStream(req: ChatCompletionRequest, spec: ModelSpec, env: Env, emitThink: boolean): Response {
  let { message, files } = extractMessage(req.messages);
  if (!message.trim()) throw new ApiError("Empty message after extraction", { status: 400, type: "invalid_request_error" });
  const toolNames = extractToolNames(req.tools || []);
  if (toolNames.length) message = injectIntoMessage(message, buildToolSystemPrompt(req.tools || [], req.tool_choice));

  const maxRetries = Math.max(0, intEnv(env, "MAX_RETRIES", 1));
  const retry = retryCodes(env);
  const responseId = makeResponseId();
  const timeoutMs = Math.max(1, floatEnv(env, "CHAT_TIMEOUT_SECONDS", 120)) * 1000;

  return sseResponse(async (write) => {
    const excluded = new Set<string>();
    let outputStarted = false;
    const maxAttempts = await maxAttemptsFor(env, spec, maxRetries);
    let retryAttempts = 0;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let account: SelectedAccount;
      try {
        account = await selectAccountOrThrow(env, spec, excluded, lastError);
      } catch (error) {
        await write(errorSse(error));
        await write("data: [DONE]\n\n");
        return;
      }
      const adapter = new StreamAdapter(env);
      const collectedAnnotations: UrlCitation[] = [];
      const sieve = toolNames.length ? new ToolSieve(toolNames) : null;
      let toolCallsEmitted = false;
      try {
        const attachments = await prepareFileAttachments(env, account.token, files);
        const payload = buildChatPayload(env, {
          message,
          modeId: spec.modeId,
          fileAttachments: attachments,
        });
        const upstream = await postGrokChat(env, account.token, payload, timeoutMs);
        for await (const line of readLines(upstream.body)) {
          const [kind, data] = classifyLine(line);
          if (kind === "done") break;
          if (kind !== "data" || !data) continue;
          let ended = false;
          for (const ev of adapter.feed(data)) {
            if (ev.kind === "text" && ev.content) {
              if (sieve) {
                const [safeText, calls] = sieve.feed(ev.content);
                if (safeText) {
                  outputStarted = true;
                  await write(sseData(makeStreamChunk(responseId, spec.id, safeText)));
                }
                if (calls?.length) {
                  toolCallsEmitted = true;
                  outputStarted = true;
                  const toolCalls = parsedToolCallsToOpenAI(calls);
                  for (const [i, call] of toolCalls.entries()) {
                    const fn = (call.function || {}) as Record<string, unknown>;
                    await write(
                      sseData(
                        makeToolCallChunk(responseId, spec.id, i, String(call.id || ""), String(fn.name || ""), String(fn.arguments || "{}"), true),
                      ),
                    );
                  }
                  const done = makeToolCallDoneChunk(responseId, spec.id);
                  const sources = adapter.searchSourcesList();
                  if (sources?.length) done.search_sources = sources;
                  await write(sseData(done));
                  await write("data: [DONE]\n\n");
                  await recordSuccessSafe(env, account);
                  return;
                }
              } else {
                outputStarted = true;
                await write(sseData(makeStreamChunk(responseId, spec.id, ev.content)));
              }
            } else if (ev.kind === "thinking" && emitThink && ev.content) {
              outputStarted = true;
              await write(sseData(makeThinkingChunk(responseId, spec.id, ev.content)));
            } else if (ev.kind === "annotation" && ev.annotationData) {
              collectedAnnotations.push(ev.annotationData);
            } else if (ev.kind === "soft_stop") {
              ended = true;
              break;
            }
          }
          if (ended) break;
        }

        if (sieve && !toolCallsEmitted) {
          const calls = sieve.flush();
          if (calls?.length) {
            outputStarted = true;
            const toolCalls = parsedToolCallsToOpenAI(calls);
            for (const [i, call] of toolCalls.entries()) {
              const fn = (call.function || {}) as Record<string, unknown>;
              await write(
                sseData(makeToolCallChunk(responseId, spec.id, i, String(call.id || ""), String(fn.name || ""), String(fn.arguments || "{}"), true)),
              );
            }
            const done = makeToolCallDoneChunk(responseId, spec.id);
            const sources = adapter.searchSourcesList();
            if (sources?.length) done.search_sources = sources;
            await write(sseData(done));
            await write("data: [DONE]\n\n");
            await recordSuccessSafe(env, account);
            return;
          }
        }

        for (const image of adapter.imageUrls) {
          const text = await resolveImageText(env, account.token, image.url, image.imageId);
          outputStarted = true;
          await write(sseData(makeStreamChunk(responseId, spec.id, `${text}\n`)));
        }
        const refs = adapter.referencesSuffix();
        if (refs) {
          outputStarted = true;
          await write(sseData(makeStreamChunk(responseId, spec.id, refs)));
        }
        const final = makeStreamChunk(responseId, spec.id, "", {
          isFinal: true,
          annotations: toChatAnnotations(collectedAnnotations),
        });
        const sources = adapter.searchSourcesList();
        if (sources?.length) final.search_sources = sources;
        await write(sseData(final));
        await write("data: [DONE]\n\n");
        await recordSuccessSafe(env, account);
        return;
      } catch (error) {
        lastError = error;
        const tokenFailure = isTokenFailure(error);
        await recordFailureSafe(env, account, error, tokenFailure);
        excluded.add(account.token);
        if (!outputStarted && tokenFailure) {
          continue;
        }
        if (!outputStarted && shouldRetry(error, retry) && retryAttempts < maxRetries) {
          retryAttempts++;
          continue;
        }
        await write(errorSse(error));
        await write("data: [DONE]\n\n");
        return;
      }
    }
    await write(errorSse(lastError || new ApiError("Chat request failed", { status: 500, type: "server_error" })));
    await write("data: [DONE]\n\n");
  });
}

async function consoleChat(req: ChatCompletionRequest, spec: ModelSpec, env: Env, isStream: boolean, emitThink: boolean): Promise<Response> {
  const { input, instructions } = buildConsoleInput(req.messages);
  if (!input.length && !instructions) throw new ApiError("Empty messages after conversion", { status: 400, type: "invalid_request_error" });
  const promptText = JSON.stringify(input);
  const baseTools = convertOpenAIToolsToConsole(req.tools || []);
  const tools = injectWebSearchTool(env, baseTools);
  const toolChoice = tools.length && req.tool_choice !== undefined && req.tool_choice !== null ? convertOpenAIToolChoice(req.tool_choice) : undefined;
  const reasoningEffort = req.reasoning_effort ?? spec.defaultReasoningEffort ?? null;
  const temperature = req.temperature ?? 0.8;
  const topP = req.top_p ?? 0.95;
  const responseId = makeResponseId();

  if (isStream) {
    return sseResponse(async (write) => {
      const maxRetries = Math.max(0, intEnv(env, "MAX_RETRIES", 1));
      const retry = retryCodes(env);
      const excluded = new Set<string>();
      let outputStarted = false;
      const maxAttempts = await maxAttemptsFor(env, spec, maxRetries);
      let retryAttempts = 0;
      let lastError: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let account: SelectedAccount;
        try {
          account = await selectAccountOrThrow(env, spec, excluded, lastError);
        } catch (error) {
          await write(errorSse(error));
          await write("data: [DONE]\n\n");
          return;
        }
        const adapter = new ConsoleStreamAdapter();
        let toolCallsEmitted = false;
        try {
          const upstream = await postConsole(env, {
            token: account.token,
            consoleModel: spec.consoleModel!,
            input,
            instructions,
            stream: true,
            temperature,
            topP,
            reasoningEffort,
            tools,
            toolChoice,
          });
          for await (const rawLine of readLines(upstream.body)) {
            const [kind, payload] = classifyConsoleSseLine(rawLine);
            if (kind === "event") {
              adapter.feedEvent(payload);
              continue;
            }
            if (kind !== "data" || !payload) continue;
            const ev = adapter.feedData(payload);
            const evKind = String(ev.kind || "skip");
            if (evKind === "text" && typeof ev.content === "string") {
              outputStarted = true;
              await write(sseData(makeStreamChunk(responseId, spec.id, ev.content)));
            } else if (evKind === "thinking" && emitThink && typeof ev.content === "string") {
              outputStarted = true;
              await write(sseData(makeThinkingChunk(responseId, spec.id, ev.content)));
            } else if (evKind === "tool_call_start") {
              toolCallsEmitted = true;
              outputStarted = true;
              await write(sseData(makeToolCallChunk(responseId, spec.id, Number(ev.index || 0), String(ev.call_id || ""), String(ev.name || ""), "", true)));
            } else if (evKind === "tool_call_args") {
              outputStarted = true;
              await write(sseData(makeToolCallChunk(responseId, spec.id, Number(ev.index || 0), "", "", String(ev.delta || ""), false)));
            } else if (evKind === "error") {
              throw new UpstreamError(String(ev.message || "Console stream error"), 502);
            } else if (evKind === "done") {
              break;
            }
          }

          if (toolCallsEmitted) {
            const done = makeToolCallDoneChunk(responseId, spec.id);
            if (adapter.searchSources.length) done.search_sources = adapter.searchSources;
            await write(sseData(done));
          } else {
            const refs = adapter.referencesSuffix(env);
            if (refs) await write(sseData(makeStreamChunk(responseId, spec.id, refs)));
            const final = makeStreamChunk(responseId, spec.id, "", {
              isFinal: true,
              annotations: toChatAnnotations(adapter.annotations),
            });
            if (adapter.searchSources.length) final.search_sources = adapter.searchSources;
            await write(sseData(final));
          }
          await write("data: [DONE]\n\n");
          await recordSuccessSafe(env, account);
          return;
        } catch (error) {
          lastError = error;
          const tokenFailure = isTokenFailure(error);
          await recordFailureSafe(env, account, error, tokenFailure);
          excluded.add(account.token);
          if (!outputStarted && tokenFailure) {
            continue;
          }
          if (!outputStarted && shouldRetry(error, retry) && retryAttempts < maxRetries) {
            retryAttempts++;
            continue;
          }
          await write(errorSse(error));
          await write("data: [DONE]\n\n");
          return;
        }
      }
      await write(errorSse(lastError || new ApiError("Console request failed", { status: 500, type: "server_error" })));
      await write("data: [DONE]\n\n");
    });
  }

  const maxRetries = Math.max(0, intEnv(env, "MAX_RETRIES", 1));
  const retry = retryCodes(env);
  const excluded = new Set<string>();
  const maxAttempts = await maxAttemptsFor(env, spec, maxRetries);
  let retryAttempts = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const account = await selectAccountOrThrow(env, spec, excluded, lastError);
    try {
      const upstream = await postConsole(env, {
        token: account.token,
        consoleModel: spec.consoleModel!,
        input,
        instructions,
        stream: false,
        temperature,
        topP,
        reasoningEffort,
        tools,
        toolChoice,
      });
      const body = (await upstream.json()) as Record<string, unknown>;
      const text = extractConsoleText(body);
      const reasoning = emitThink ? extractConsoleReasoning(body) : "";
      const toolCalls = extractConsoleToolCalls(body);
      const annotations = extractConsoleAnnotations(body);
      const searchSources = extractConsoleSearchSources(body);
      const usage = extractConsoleUsage(body);
      const pt = usage.prompt_tokens || estimateTokens(promptText);
      const ct = usage.completion_tokens || estimateTokens(text) + estimateTokens(reasoning) + estimateTokens(toolCalls);
      const rt = usage.reasoning_tokens || estimateTokens(reasoning);
      const completionTokens = Math.max(ct, rt);

      if (toolCalls.length) {
        const resp = makeToolCallResponse(spec.id, toolCalls, {
          promptContent: promptText,
          responseId,
          usage: buildUsage(pt, completionTokens, rt),
        });
        if (searchSources.length) resp.search_sources = searchSources;
        await recordSuccessSafe(env, account);
        return json(resp);
      }
      const response = makeChatResponse(spec.id, text, {
          promptContent: promptText,
          responseId,
          reasoningContent: reasoning || null,
          annotations: toChatAnnotations(annotations),
          searchSources,
          usage: buildUsage(pt, completionTokens, rt),
        });
      await recordSuccessSafe(env, account);
      return json(response);
    } catch (error) {
      lastError = error;
      const tokenFailure = isTokenFailure(error);
      await recordFailureSafe(env, account, error, tokenFailure);
      excluded.add(account.token);
      if (tokenFailure) {
        continue;
      }
      if (shouldRetry(error, retry) && retryAttempts < maxRetries) {
        retryAttempts++;
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new ApiError("Console request failed", { status: 500, type: "server_error" });
}

function extractMessage(messages: ChatMessage[]): { message: string; files: string[] } {
  const parts: string[] = [];
  const files: string[] = [];

  for (const msg of messages) {
    const role = msg.role || "user";
    const content = msg.content || "";

    if (role === "tool") {
      const text = typeof content === "string" ? content.trim() : "";
      if (text) parts.push(`${msg.tool_call_id ? `[tool result for ${msg.tool_call_id}]` : "[tool result]"}:\n${text}`);
      continue;
    }

    if (role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const xml = toolCallsToXml(msg.tool_calls);
      const text = typeof content === "string" ? stripGeneratedArtifacts(content.trim(), true) : "";
      parts.push(text ? `[assistant]: ${text}\n${xml}` : `[assistant]:\n${xml}`);
      continue;
    }

    if (typeof content === "string") {
      const cleaned = stripGeneratedArtifacts(content.trim(), role === "assistant");
      if (cleaned) parts.push(`[${role}]: ${cleaned}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const row = block as Record<string, unknown>;
        if (row.type === "text") {
          const text = typeof row.text === "string" ? stripGeneratedArtifacts(row.text.trim(), role === "assistant") : "";
          if (text) parts.push(`[${role}]: ${text}`);
        } else if (row.type === "image_url") {
          const inner = row.image_url;
          const url = typeof inner === "string" ? inner : inner && typeof inner === "object" ? String((inner as Record<string, unknown>).url || "") : "";
          if (url) files.push(url);
        } else if (row.type === "input_audio" || row.type === "file") {
          const inner = row[row.type] as Record<string, unknown> | undefined;
          const data = inner?.data || inner?.file_data;
          if (typeof data === "string" && data) files.push(data);
        }
      }
    }
  }
  return { message: parts.join("\n\n"), files };
}

function extractLastUserText(messages: ChatMessage[]): string {
  for (const msg of [...messages].reverse()) {
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string" && msg.content.trim()) return msg.content.trim();
    if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
        .map((b) => String((b as Record<string, unknown>).text || ""))
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

const SOURCES_STRIP_RE = /(?:^|\r?\n\r?\n)## Sources\r?\n\[grok2api-sources\]: #\r?\n[\s\S]*$/;
function stripGeneratedArtifacts(text: string, stripSources = false): string {
  return (stripSources ? text.replace(SOURCES_STRIP_RE, "") : text).trim();
}

async function prepareFileAttachments(env: Env, token: string, files: string[]): Promise<string[]> {
  const attachments: string[] = [];
  for (const file of files) {
    if (!file) continue;
    attachments.push(await uploadFromInput(env, token, file));
  }
  return attachments;
}

async function resolveImageText(env: Env, token: string, url: string, imageId: string): Promise<string> {
  const format = (env.IMAGE_FORMAT || "grok_url").trim().toLowerCase();
  if (format === "grok_md") return `![image](${url})`;
  if (format === "base64") {
    const { bytes, contentType } = await downloadAsset(env, token, url);
    return `![image](data:${contentType};base64,${bytesToBase64(bytes)})`;
  }
  if (format === "local_url" || format === "local_md") {
    // Worker has no local filesystem/cache. Fall back to upstream URL while preserving markdown mode.
    return format === "local_md" ? `![image](${url})` : url;
  }
  void imageId;
  return url;
}

function toChatAnnotations(anns: Array<UrlCitation | { url: string; title: string; start_index: number; end_index: number }>): unknown[] | null {
  if (!anns.length) return null;
  return anns.map((a) => ({
    type: "url_citation",
    url_citation: {
      url: a.url,
      title: a.title,
      start_index: a.start_index,
      end_index: a.end_index,
    },
  }));
}

async function maxAttemptsFor(env: Env, spec: ModelSpec, maxRetries: number): Promise<number> {
  const tokenCount = await countTokensForPools(env, poolCandidates(spec)).catch(() => 1);
  return Math.max(1, tokenCount) + Math.max(0, maxRetries);
}

async function selectAccountOrThrow(
  env: Env,
  spec: ModelSpec,
  excluded: Set<string>,
  lastError?: unknown,
): Promise<SelectedAccount> {
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

function shouldRetry(error: unknown, retry: Set<number>): boolean {
  if (error instanceof UpstreamError) return retry.has(error.status) || error.status === 401;
  return false;
}

function errorSse(error: unknown): string {
  const e = normalizeError(error);
  return `event: error\ndata: ${JSON.stringify(e.toJSON())}\n\n`;
}

function sseResponse(run: (write: (chunk: string) => Promise<void>) => Promise<void>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = async (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
      };
      run(write)
        .catch((error) => {
          controller.enqueue(encoder.encode(errorSse(error)));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        })
        .finally(() => controller.close());
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8" } });
}
