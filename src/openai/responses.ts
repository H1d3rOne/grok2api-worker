import type { Env, ResponsesCreateRequest, ChatMessage } from "../types";
import { selectAccount, type SelectedAccount } from "../accounts";
import { boolEnv, intEnv, retryCodes } from "../config";
import { ApiError, UpstreamError } from "../errors";
import { assertReasoningEffortSupported, getModel, isRuntimeAvailableModel, poolCandidates, useConsoleUpstream } from "../models";
import { countTokensForPools, isTokenFailure, recordTokenFailure, recordTokenSuccess } from "../token-pool";
import {
  injectWebSearchTool,
  postConsole,
} from "../xai/console";
import { readLines } from "../xai/http";
import { handleChatCompletions } from "./chat";
import { estimateTokens, makeResponsesId, makeResponsesObject, nowSeconds, sseEvent } from "./format";

export async function handleResponses(request: Request, env: Env): Promise<Response> {
  const req = (await request.json().catch(() => null)) as ResponsesCreateRequest | null;
  if (!req || typeof req !== "object") throw new ApiError("Request body must be JSON", { status: 400, type: "invalid_request_error" });
  if (!req.model) throw new ApiError("model is required", { status: 400, type: "invalid_request_error", param: "model" });
  if (req.input === undefined || req.input === null || (typeof req.input === "string" && !req.input.trim())) {
    throw new ApiError("input cannot be empty", { status: 400, type: "invalid_request_error", param: "input" });
  }

  const spec = getModel(req.model);
  if (!spec || !spec.enabled) {
    throw new ApiError(`Model ${JSON.stringify(req.model)} does not exist or you do not have access to it.`, {
      status: 404,
      type: "invalid_request_error",
      code: "model_not_found",
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

  if (spec.consoleModel && useConsoleUpstream(env)) return consoleResponses(req, spec, env, isStream);
  return legacyResponses(req, env, isStream);
}

async function consoleResponses(
  req: ResponsesCreateRequest,
  spec: NonNullable<ReturnType<typeof getModel>>,
  env: Env,
  isStream: boolean,
): Promise<Response> {
  if (!boolEnv(env, "ENABLE_CONSOLE_MODELS", true)) {
    throw new ApiError("Console models are disabled by ENABLE_CONSOLE_MODELS=false", { status: 501, type: "not_supported_error" });
  }
  const effort = typeof req.reasoning?.effort === "string" ? req.reasoning.effort : spec.defaultReasoningEffort || null;
  assertReasoningEffortSupported(spec, effort, "reasoning.effort");
  const tools = injectWebSearchTool(env, Array.isArray(req.tools) ? req.tools : []);
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
        input: req.input,
        instructions: req.instructions || "",
        stream: isStream,
        temperature: req.temperature ?? null,
        topP: req.top_p ?? null,
        reasoningEffort: effort,
        tools,
        toolChoice: req.tool_choice,
      });

      await recordSuccessSafe(env, account);
      if (isStream) {
        return relayConsoleResponsesStream(upstream, spec.id);
      }
      const body = (await upstream.json()) as Record<string, unknown>;
      body.model = spec.id;
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8" } });
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

  throw lastError instanceof Error ? lastError : new ApiError("Console response request failed", { status: 500, type: "server_error" });
}

function relayConsoleResponsesStream(upstream: Response, model: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = async (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
      };
      (async () => {
        let currentEvent = "";
        for await (const rawLine of readLines(upstream.body)) {
          const line = rawLine.trim();
          if (!line) continue;
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
            continue;
          }
          let data = "";
          if (line.startsWith("data:")) data = line.slice(5).trim();
          else if (line.startsWith("{")) data = line;
          else continue;

          if (data === "[DONE]") {
            break;
          }
          data = normalizeConsoleResponsesData(data, model);
          if (currentEvent) {
            await write(`event: ${currentEvent}\ndata: ${data}\n\n`);
            currentEvent = "";
          } else {
            await write(`data: ${data}\n\n`);
          }
        }
        await write("data: [DONE]\n\n");
      })()
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error || "Console responses stream relay failed");
          controller.enqueue(encoder.encode(sseEvent("response.failed", { type: "response.failed", error: { message, type: "upstream_error" } })));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        })
        .finally(() => controller.close());
    },
  });
  return new Response(stream, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function normalizeConsoleResponsesData(data: string, model: string): string {
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!parsed || typeof parsed !== "object") return data;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.model === "string") obj.model = model;
    if (obj.response && typeof obj.response === "object") {
      const response = obj.response as Record<string, unknown>;
      if (typeof response.model === "string") response.model = model;
    }
    return JSON.stringify(obj);
  } catch {
    return data;
  }
}

async function legacyResponses(req: ResponsesCreateRequest, env: Env, isStream: boolean): Promise<Response> {
  const messages = responsesInputToMessages(req.input, req.instructions || "");
  const chatReq = new Request("https://worker.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: req.model,
      messages,
      stream: isStream,
      reasoning_effort: typeof req.reasoning?.effort === "string" ? req.reasoning.effort : undefined,
      temperature: req.temperature,
      top_p: req.top_p,
      max_tokens: req.max_output_tokens,
      tools: Array.isArray(req.tools) ? responsesToolsToChatTools(req.tools) : undefined,
      tool_choice: req.tool_choice,
    }),
  });
  const chatResp = await handleChatCompletions(chatReq, env);
  if (isStream) return chatStreamToResponses(chatResp, req.model);

  const chat = (await chatResp.json()) as Record<string, unknown>;
  const choice = Array.isArray(chat.choices) ? (chat.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  const toolCalls = Array.isArray(message?.tool_calls) ? (message.tool_calls as Array<Record<string, unknown>>) : [];
  const output: Array<Record<string, unknown>> = [];
  if (reasoning) output.push(makeReasoningOutputItem(reasoning));
  if (toolCalls.length) {
    output.push(...toolCalls.map(chatToolCallToResponseItem));
    const usage = chat.usage as Record<string, unknown> | undefined;
    const response = makeResponsesObject(makeResponsesId("resp"), req.model, "completed", output, usage ? chatUsageToResponsesUsage(usage) : null);
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json; charset=utf-8" } });
  }
  const text = typeof message?.content === "string" ? message.content : "";
  const msgItem: Record<string, unknown> = {
    id: makeResponsesId("msg"),
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: Array.isArray(message?.annotations) ? message.annotations : [] }],
  };
  if (Array.isArray(chat.search_sources) && chat.search_sources.length) msgItem.search_sources = chat.search_sources;
  output.push(msgItem);
  const usage = chat.usage as Record<string, unknown> | undefined;
  const response = makeResponsesObject(makeResponsesId("resp"), req.model, "completed", output, usage ? chatUsageToResponsesUsage(usage) : null);
  return new Response(JSON.stringify(response), { headers: { "content-type": "application/json; charset=utf-8" } });
}

function chatStreamToResponses(chatResponse: Response, model: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = async (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
      };
      runChatStreamToResponses(chatResponse, model, write)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error || "Responses stream conversion failed");
          controller.enqueue(
            encoder.encode(
              sseEvent("response.failed", {
                type: "response.failed",
                response: makeResponsesObject(makeResponsesId("resp"), model, "failed", []),
                error: { message, type: "server_error", code: null, param: null },
              }),
            ),
          );
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

async function runChatStreamToResponses(chatResponse: Response, model: string, write: (chunk: string) => Promise<void>): Promise<void> {
  const responseId = makeResponsesId("resp");
  const reasoningId = makeResponsesId("rs");
  const messageId = makeResponsesId("msg");
  const output: Array<Record<string, unknown>> = [];
  const annotations: unknown[] = [];
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolItems = new Map<number, { outputIndex: number; item: Record<string, unknown>; args: string[] }>();
  let nextOutputIndex = 0;
  let reasoningStarted = false;
  let reasoningClosed = false;
  let reasoningOutputIndex = -1;
  let messageStarted = false;
  let messageClosed = false;
  let finalUsage: Record<string, unknown> | null = null;

  await write(
    sseEvent("response.created", {
      type: "response.created",
      response: makeResponsesObject(responseId, model, "in_progress", []),
    }),
  );

  const closeReasoning = async () => {
    if (!reasoningStarted || reasoningClosed) return;
    reasoningClosed = true;
    const fullReasoning = reasoningParts.join("");
    const outputIndex = reasoningOutputIndex >= 0 ? reasoningOutputIndex : nextOutputIndex;
    await write(
      sseEvent("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        item_id: reasoningId,
        output_index: outputIndex,
        summary_index: 0,
        text: fullReasoning,
      }),
    );
    await write(
      sseEvent("response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        item_id: reasoningId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: fullReasoning },
      }),
    );
    const item = {
      id: reasoningId,
      type: "reasoning",
      summary: [{ type: "summary_text", text: fullReasoning }],
      status: "completed",
    };
    output.push(item);
    nextOutputIndex = Math.max(nextOutputIndex, outputIndex + 1);
    await write(sseEvent("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item }));
  };

  const startMessage = async () => {
    if (messageStarted) return;
    await closeReasoning();
    messageStarted = true;
    await write(
      sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: nextOutputIndex,
        item: {
          id: messageId,
          type: "message",
          role: "assistant",
          content: [],
          status: "in_progress",
        },
      }),
    );
    await write(
      sseEvent("response.content_part.added", {
        type: "response.content_part.added",
        item_id: messageId,
        output_index: nextOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
    );
  };

  const closeMessage = async () => {
    if (!messageStarted || messageClosed) return;
    messageClosed = true;
    const outputIndex = nextOutputIndex++;
    const fullText = textParts.join("");
    await write(
      sseEvent("response.output_text.done", {
        type: "response.output_text.done",
        item_id: messageId,
        output_index: outputIndex,
        content_index: 0,
        text: fullText,
      }),
    );
    const part = { type: "output_text", text: fullText, annotations };
    await write(
      sseEvent("response.content_part.done", {
        type: "response.content_part.done",
        item_id: messageId,
        output_index: outputIndex,
        content_index: 0,
        part,
      }),
    );
    const item = {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [part],
      status: "completed",
    };
    output.push(item);
    await write(sseEvent("response.output_item.done", { type: "response.output_item.done", output_index: outputIndex, item }));
  };

  const startReasoning = async () => {
    if (reasoningStarted) return;
    await closeMessage();
    reasoningStarted = true;
    reasoningOutputIndex = nextOutputIndex;
    await write(
      sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: reasoningOutputIndex,
        item: { id: reasoningId, type: "reasoning", summary: [], status: "in_progress" },
      }),
    );
    await write(
      sseEvent("response.reasoning_summary_part.added", {
        type: "response.reasoning_summary_part.added",
        item_id: reasoningId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    );
  };

  const startToolCall = async (tcIndex: number, tc: Record<string, unknown>, fn: Record<string, unknown>) => {
    if (toolItems.has(tcIndex)) return;
    await closeReasoning();
    await closeMessage();
    const outputIndex = nextOutputIndex++;
    const item: Record<string, unknown> = {
      id: makeResponsesId("fc"),
      type: "function_call",
      call_id: String(tc.id || makeResponsesId("call")),
      name: String(fn.name || ""),
      arguments: "",
      status: "in_progress",
    };
    toolItems.set(tcIndex, { outputIndex, item, args: [] });
    await write(
      sseEvent("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item,
      }),
    );
  };

  let currentEvent = "";
  for await (const line of readLines(chatResponse.body)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("event:")) {
      currentEvent = trimmed.slice(6).trim();
      continue;
    }
    if (!trimmed.startsWith("data:")) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw) continue;
    if (raw === "[DONE]") break;

    const chunk = parseJsonObject(raw);
    if (chunk.error) {
      await write(sseEvent("response.failed", { type: "response.failed", response: makeResponsesObject(responseId, model, "failed", output), error: chunk.error }));
      await write("data: [DONE]\n\n");
      return;
    }
    if (currentEvent === "error") {
      await write(sseEvent("response.failed", { type: "response.failed", response: makeResponsesObject(responseId, model, "failed", output), error: chunk.error || chunk }));
      await write("data: [DONE]\n\n");
      return;
    }

    const usage = chunk.usage as Record<string, unknown> | undefined;
    if (usage) finalUsage = chatUsageToResponsesUsage(usage);

    const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as Record<string, unknown> | undefined) : undefined;
    if (!choice) continue;
    const delta = (choice.delta || {}) as Record<string, unknown>;

    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    if (reasoning) {
      await startReasoning();
      reasoningParts.push(reasoning);
      await write(
        sseEvent("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          item_id: reasoningId,
          output_index: reasoningOutputIndex,
          summary_index: 0,
          delta: reasoning,
        }),
      );
    }

    const text = typeof delta.content === "string" ? delta.content : "";
    if (text) {
      await startMessage();
      textParts.push(text);
      await write(
        sseEvent("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: messageId,
          output_index: nextOutputIndex,
          content_index: 0,
          delta: text,
        }),
      );
    }

    if (Array.isArray(delta.annotations)) {
      await startMessage();
      for (const ann of delta.annotations) {
        const annotationIndex = annotations.length;
        annotations.push(ann);
        await write(
          sseEvent("response.output_text.annotation.added", {
            type: "response.output_text.annotation.added",
            item_id: messageId,
            output_index: nextOutputIndex,
            content_index: 0,
            annotation_index: annotationIndex,
            annotation: ann,
          }),
        );
      }
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const rawToolCall of toolCalls) {
      if (!rawToolCall || typeof rawToolCall !== "object") continue;
      const tc = rawToolCall as Record<string, unknown>;
      const tcIndex = Number(tc.index || 0);
      const fn = (tc.function || {}) as Record<string, unknown>;
      await startToolCall(tcIndex, tc, fn);
      const state = toolItems.get(tcIndex);
      if (!state) continue;
      const argsDelta = typeof fn.arguments === "string" ? fn.arguments : "";
      if (argsDelta) {
        state.args.push(argsDelta);
        await write(
          sseEvent("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            item_id: state.item.id,
            output_index: state.outputIndex,
            delta: argsDelta,
          }),
        );
      }
      if (typeof fn.name === "string" && fn.name) state.item.name = fn.name;
      if (typeof tc.id === "string" && tc.id) state.item.call_id = tc.id;
    }

    if (typeof choice.finish_reason === "string" && choice.finish_reason === "tool_calls") {
      await closeMessage();
    }
    currentEvent = "";
  }

  await closeReasoning();
  await closeMessage();
  for (const state of toolItems.values()) {
    const args = state.args.join("");
    state.item.arguments = args || state.item.arguments || "{}";
    state.item.status = "completed";
    await write(
      sseEvent("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: state.item.id,
        output_index: state.outputIndex,
        arguments: state.item.arguments,
      }),
    );
    output.push(state.item);
    await write(
      sseEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: state.outputIndex,
        item: state.item,
      }),
    );
  }
  if (!output.length) {
    const item = {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }],
      status: "completed",
    };
    output.push(item);
  }

  const fallbackReasoningTokens = estimateTokens(reasoningParts.join(""));
  const fallbackOutputTokens = estimateTokens(textParts.join("")) + fallbackReasoningTokens + estimateTokens([...toolItems.values()].map((x) => x.item));
  const usage =
    finalUsage || {
      input_tokens: 0,
      output_tokens: fallbackOutputTokens,
      total_tokens: fallbackOutputTokens,
      output_tokens_details: { reasoning_tokens: fallbackReasoningTokens },
    };
  await write(
    sseEvent("response.completed", {
      type: "response.completed",
      response: makeResponsesObject(responseId, model, "completed", output, usage),
    }),
  );
  await write("data: [DONE]\n\n");
}

function makeReasoningOutputItem(text: string): Record<string, unknown> {
  return {
    id: makeResponsesId("rs"),
    type: "reasoning",
    summary: [{ type: "summary_text", text }],
    status: "completed",
  };
}

function chatToolCallToResponseItem(call: Record<string, unknown>): Record<string, unknown> {
  const fn = (call.function || {}) as Record<string, unknown>;
  return {
    id: makeResponsesId("fc"),
    type: "function_call",
    call_id: call.id || makeResponsesId("call"),
    name: fn.name || "",
    arguments: fn.arguments || "{}",
    status: "completed",
  };
}

function responsesInputToMessages(input: string | unknown[], instructions: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (instructions.trim()) messages.push({ role: "system", content: instructions.trim() });
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  for (const item of input) {
    if (!item || typeof item !== "object") {
      messages.push({ role: "user", content: String(item) });
      continue;
    }
    const row = item as Record<string, unknown>;
    const itemType = typeof row.type === "string" ? row.type : row.role ? "message" : "";

    if (itemType === "function_call") {
      const callId = String(row.call_id || row.id || makeResponsesId("call"));
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: callId,
            type: "function",
            function: {
              name: String(row.name || ""),
              arguments: typeof row.arguments === "string" ? row.arguments : JSON.stringify(row.arguments ?? {}),
            },
          },
        ],
      });
      continue;
    }

    if (itemType === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(row.call_id || ""),
        content: stringifyContent(row.output),
      });
      continue;
    }

    if (itemType && itemType !== "message") continue;

    const role = typeof row.role === "string" ? row.role : "user";
    const content = convertResponsesContent(row.content ?? row.text ?? "");
    messages.push({ role, content });
  }
  return messages;
}

function convertResponsesContent(content: unknown): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyContent(content);
  const out: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (typeof block === "string") {
      out.push({ type: "text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const row = block as Record<string, unknown>;
    const type = row.type;
    if (type === "input_text" || type === "output_text" || type === "text") {
      out.push({ type: "text", text: String(row.text || "") });
    } else if (type === "input_image" || type === "image" || type === "image_url") {
      const url = responseImageUrl(row);
      if (url) out.push({ type: "image_url", image_url: { url, detail: String(row.detail || "auto") } });
    } else if (type === "input_file") {
      const data = row.file_data || row.data || row.file_id;
      if (data) out.push({ type: "file", file: { data: String(data), filename: row.filename || undefined } });
    } else if (type === "file" || type === "input_audio") {
      out.push({ ...row });
    } else if (typeof row.text === "string") {
      out.push({ type: "text", text: row.text });
    } else {
      out.push({ type: "text", text: JSON.stringify(row) });
    }
  }
  return out;
}

function responseImageUrl(row: Record<string, unknown>): string {
  const direct = row.image_url || row.url;
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") {
    const obj = direct as Record<string, unknown>;
    if (typeof obj.url === "string") return obj.url;
  }
  const source = row.source;
  if (source && typeof source === "object") {
    const src = source as Record<string, unknown>;
    if (typeof src.url === "string") return src.url;
    if (src.type === "base64" && typeof src.data === "string") {
      return `data:${src.media_type || "image/jpeg"};base64,${src.data}`;
    }
  }
  return "";
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function chatUsageToResponsesUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const completionDetails = (usage.completion_tokens_details || {}) as Record<string, unknown>;
  const inputTokens = Number(usage.prompt_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || 0);
  const totalTokens = Number(usage.total_tokens || inputTokens + outputTokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    output_tokens_details: { reasoning_tokens: Number(completionDetails.reasoning_tokens || 0) },
  };
}

function responsesToolsToChatTools(tools: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const row = tool as Record<string, unknown>;
    if (row.type === "function" && !row.function && row.name) {
      out.push({
        type: "function",
        function: {
          name: row.name || "",
          description: row.description || "",
          parameters: row.parameters || {},
        },
      });
    } else {
      out.push({ ...row });
    }
  }
  return out;
}

async function maxAttemptsFor(env: Env, spec: NonNullable<ReturnType<typeof getModel>>, maxRetries: number): Promise<number> {
  const tokenCount = await countTokensForPools(env, poolCandidates(spec)).catch(() => 1);
  return Math.max(1, tokenCount) + Math.max(0, maxRetries);
}

async function selectAccountOrThrow(
  env: Env,
  spec: NonNullable<ReturnType<typeof getModel>>,
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

void nowSeconds;
