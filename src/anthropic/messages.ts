import type { AnthropicMessagesRequest, ChatMessage, Env } from "../types";
import { ApiError } from "../errors";
import { getModel, isRuntimeAvailableModel, isWorkerSupportedModel } from "../models";
import { handleChatCompletions } from "../openai/chat";
import { estimateTokens, makeResponsesId, sseData } from "../openai/format";
import { readLines } from "../xai/http";

const encoder = new TextEncoder();

export async function handleAnthropicMessages(request: Request, env: Env): Promise<Response> {
  const req = (await request.json().catch(() => null)) as AnthropicMessagesRequest | null;
  if (!req || typeof req !== "object") throw new ApiError("Request body must be JSON", { status: 400, type: "invalid_request_error" });
  await validateAnthropicRequest(req, env);

  const stream = req.stream === true;
  const chatReq = anthropicToChatRequest(req, stream);
  const response = await handleChatCompletions(
    new Request("https://worker.local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatReq),
    }),
    env,
  );

  if (stream) return chatStreamToAnthropic(response, req.model);
  const chat = (await response.json()) as Record<string, unknown>;
  return new Response(JSON.stringify(chatCompletionToAnthropic(chat, req.model)), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function validateAnthropicRequest(req: AnthropicMessagesRequest, env: Env): Promise<void> {
  if (!req.model || typeof req.model !== "string") {
    throw new ApiError("model is required", { status: 400, type: "invalid_request_error", param: "model" });
  }
  const spec = getModel(req.model);
  if (!spec || !spec.enabled || !isWorkerSupportedModel(spec)) {
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
  if (!Array.isArray(req.messages) || req.messages.length === 0) {
    throw new ApiError("messages cannot be empty", { status: 400, type: "invalid_request_error", param: "messages" });
  }
  if (req.temperature !== undefined && req.temperature !== null && (req.temperature < 0 || req.temperature > 2)) {
    throw new ApiError("temperature must be between 0 and 2", { status: 400, type: "invalid_request_error", param: "temperature" });
  }
  if (req.top_p !== undefined && req.top_p !== null && (req.top_p < 0 || req.top_p > 1)) {
    throw new ApiError("top_p must be between 0 and 1", { status: 400, type: "invalid_request_error", param: "top_p" });
  }
}

function anthropicToChatRequest(req: AnthropicMessagesRequest, stream: boolean): Record<string, unknown> {
  const messages = parseAnthropicMessages(req.messages, req.system);
  const thinkingType = typeof req.thinking?.type === "string" ? req.thinking.type : "";
  const reasoningEffort = thinkingType === "enabled" ? undefined : "none";
  return {
    model: req.model,
    messages,
    stream,
    temperature: req.temperature ?? undefined,
    top_p: req.top_p ?? undefined,
    max_tokens: req.max_tokens ?? undefined,
    reasoning_effort: reasoningEffort,
    tools: req.tools?.length ? convertAnthropicTools(req.tools) : undefined,
    tool_choice: req.tools?.length ? convertAnthropicToolChoice(req.tool_choice) : undefined,
  };
}

function parseAnthropicMessages(messages: AnthropicMessagesRequest["messages"], system: AnthropicMessagesRequest["system"]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const systemText = systemToText(system);
  if (systemText.trim()) out.push({ role: "system", content: systemText.trim() });

  for (const msg of messages) {
    const role = msg.role || "user";
    const content = msg.content;
    out.push(...anthropicContentToChatMessages(content, role));
  }
  return out;
}

function systemToText(system: AnthropicMessagesRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return String(system);
  return system
    .filter((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
    .map((b) => String((b as Record<string, unknown>).text || ""))
    .filter(Boolean)
    .join("\n");
}

function anthropicContentToChatMessages(content: unknown, role: string): ChatMessage[] {
  if (typeof content === "string") return [{ role, content }];
  if (!Array.isArray(content)) return [];

  const toolResultBlocks = content.filter((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_result");
  if (toolResultBlocks.length) {
    return toolResultBlocks.map((block) => {
      const row = block as Record<string, unknown>;
      return {
        role: "tool",
        tool_call_id: String(row.tool_use_id || ""),
        content: blockText(row.content),
      };
    });
  }

  const toolUseBlocks = content.filter((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_use");
  if (toolUseBlocks.length) {
    const text = content
      .filter((b) => b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
      .map((b) => String((b as Record<string, unknown>).text || ""))
      .filter(Boolean)
      .join("\n");
    return [
      {
        role: "assistant",
        content: text || null,
        tool_calls: toolUseBlocks.map((block) => {
          const row = block as Record<string, unknown>;
          return {
            id: String(row.id || makeToolId()),
            type: "function",
            function: {
              name: String(row.name || ""),
              arguments: JSON.stringify(row.input || {}),
            },
          };
        }),
      },
    ];
  }

  const blocks: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const row = block as Record<string, unknown>;
    if (row.type === "text") {
      const text = typeof row.text === "string" ? row.text.trim() : "";
      if (text) blocks.push({ type: "text", text });
    } else if (row.type === "image") {
      const source = (row.source || {}) as Record<string, unknown>;
      if (source.type === "base64") {
        blocks.push({
          type: "image_url",
          image_url: { url: `data:${source.media_type || "image/jpeg"};base64,${source.data || ""}` },
        });
      } else if (source.type === "url") {
        blocks.push({ type: "image_url", image_url: { url: source.url || "" } });
      }
    } else if (row.type === "document") {
      const source = (row.source || {}) as Record<string, unknown>;
      if (source.type === "base64") {
        blocks.push({
          type: "file",
          file: { data: `data:${source.media_type || "application/pdf"};base64,${source.data || ""}` },
        });
      }
    }
  }

  return blocks.length ? [{ role, content: blocks }] : [];
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return String(item ?? "");
      const row = item as Record<string, unknown>;
      return row.type === "text" ? String(row.text || "") : JSON.stringify(row);
    })
    .filter(Boolean)
    .join("\n");
}

function convertAnthropicTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name || "",
      description: tool.description || "",
      parameters: tool.input_schema || {},
    },
  }));
}

function convertAnthropicToolChoice(choice: unknown): unknown {
  if (!choice) return "auto";
  if (typeof choice === "string") return choice;
  if (typeof choice === "object") {
    const row = choice as Record<string, unknown>;
    if (row.type === "any") return "required";
    if (row.type === "tool") return { type: "function", function: { name: row.name || "" } };
    if (row.type === "auto") return "auto";
  }
  return choice;
}

function chatCompletionToAnthropic(chat: Record<string, unknown>, model: string): Record<string, unknown> {
  if (chat.error) {
    throw new ApiError(String(((chat.error as Record<string, unknown>) || {}).message || "Chat request failed"), {
      status: 502,
      type: "upstream_error",
    });
  }
  const choice = Array.isArray(chat.choices) ? (chat.choices[0] as Record<string, unknown> | undefined) : undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const contentText = typeof message?.content === "string" ? message.content : "";
  const thinking = typeof message?.reasoning_content === "string" ? message.reasoning_content : "";
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const content: Array<Record<string, unknown>> = [];
  if (thinking) content.push({ type: "thinking", thinking });
  if (contentText || !toolCalls.length) {
    const textBlock: Record<string, unknown> = { type: "text", text: contentText };
    if (Array.isArray(message?.annotations) && message.annotations.length) textBlock.annotations = message.annotations;
    content.push(textBlock);
  }
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue;
    const row = call as Record<string, unknown>;
    const fn = (row.function || {}) as Record<string, unknown>;
    content.push({
      type: "tool_use",
      id: anthropicToolUseId(row.id),
      name: fn.name || "",
      input: parseJsonObject(fn.arguments),
    });
  }
  const usage = (chat.usage || {}) as Record<string, unknown>;
  const response: Record<string, unknown> = {
    id: makeResponsesId("msg"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: finishReasonToStopReason(typeof choice?.finish_reason === "string" ? choice.finish_reason : null),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens || 0),
      output_tokens: Number(usage.completion_tokens || estimateTokens(contentText)),
    },
  };
  if (Array.isArray(chat.search_sources) && chat.search_sources.length) response.search_sources = chat.search_sources;
  return response;
}

function chatStreamToAnthropic(chatResponse: Response, model: string): Response {
  return anthropicSseResponse(async (write) => {
    const msgId = makeResponsesId("msg");
    await write(
      sse("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );

    let nextIndex = 0;
    let textIndex = -1;
    let thinkingIndex = -1;
    let textOpen = false;
    let thinkingOpen = false;
    let fullText = "";
    let outputTokens = 0;
    let stopReason = "end_turn";
    let emittedContentBlock = false;
    const toolBlocks = new Map<number, number>();

    for await (const line of readLines(chatResponse.body)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const raw = trimmed.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;

      const chunk = parseJsonObject(raw);
      if (chunk.error) {
        await write(sse("error", { type: "error", error: chunk.error }));
        continue;
      }
      const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as Record<string, unknown> | undefined) : undefined;
      if (!choice) {
        const usage = chunk.usage as Record<string, unknown> | undefined;
        if (usage) outputTokens = Number(usage.completion_tokens || outputTokens);
        continue;
      }
      const delta = (choice.delta || {}) as Record<string, unknown>;

      const thinking = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
      if (thinking) {
        if (textOpen) {
          await write(sse("content_block_stop", { type: "content_block_stop", index: textIndex }));
          textOpen = false;
        }
        if (!thinkingOpen) {
          thinkingIndex = nextIndex++;
          thinkingOpen = true;
          emittedContentBlock = true;
          await write(sse("content_block_start", { type: "content_block_start", index: thinkingIndex, content_block: { type: "thinking", thinking: "" } }));
        }
        await write(sse("content_block_delta", { type: "content_block_delta", index: thinkingIndex, delta: { type: "thinking_delta", thinking } }));
      }

      const text = typeof delta.content === "string" ? delta.content : "";
      if (text) {
        if (thinkingOpen) {
          await write(sse("content_block_stop", { type: "content_block_stop", index: thinkingIndex }));
          thinkingOpen = false;
        }
        if (!textOpen) {
          textIndex = nextIndex++;
          textOpen = true;
          emittedContentBlock = true;
          await write(sse("content_block_start", { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } }));
        }
        await write(sse("content_block_delta", { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text } }));
        fullText += text;
      }

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const toolCall of toolCalls) {
        if (!toolCall || typeof toolCall !== "object") continue;
        const tc = toolCall as Record<string, unknown>;
        const tcIndex = Number(tc.index || 0);
        const fn = (tc.function || {}) as Record<string, unknown>;
        if (!toolBlocks.has(tcIndex)) {
          if (thinkingOpen) {
            await write(sse("content_block_stop", { type: "content_block_stop", index: thinkingIndex }));
            thinkingOpen = false;
          }
          if (textOpen) {
            await write(sse("content_block_stop", { type: "content_block_stop", index: textIndex }));
            textOpen = false;
          }
          const blockIndex = nextIndex++;
          toolBlocks.set(tcIndex, blockIndex);
          emittedContentBlock = true;
          await write(
            sse("content_block_start", {
              type: "content_block_start",
              index: blockIndex,
              content_block: { type: "tool_use", id: anthropicToolUseId(tc.id), name: fn.name || "", input: {} },
            }),
          );
        }
        const args = typeof fn.arguments === "string" ? fn.arguments : "";
        if (args) {
          await write(
            sse("content_block_delta", {
              type: "content_block_delta",
              index: toolBlocks.get(tcIndex),
              delta: { type: "input_json_delta", partial_json: args },
            }),
          );
        }
      }

      if (typeof choice.finish_reason === "string") stopReason = finishReasonToStopReason(choice.finish_reason);
      const usage = chunk.usage as Record<string, unknown> | undefined;
      if (usage) outputTokens = Number(usage.completion_tokens || outputTokens);
    }

    if (thinkingOpen) await write(sse("content_block_stop", { type: "content_block_stop", index: thinkingIndex }));
    if (textOpen) await write(sse("content_block_stop", { type: "content_block_stop", index: textIndex }));
    for (const blockIndex of toolBlocks.values()) await write(sse("content_block_stop", { type: "content_block_stop", index: blockIndex }));
    if (!emittedContentBlock) {
      const emptyIndex = nextIndex++;
      await write(sse("content_block_start", { type: "content_block_start", index: emptyIndex, content_block: { type: "text", text: "" } }));
      await write(sse("content_block_stop", { type: "content_block_stop", index: emptyIndex }));
    }
    if (toolBlocks.size && stopReason === "end_turn") stopReason = "tool_use";

    await write(
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens || estimateTokens(fullText) },
      }),
    );
    await write(sse("message_stop", { type: "message_stop" }));
  });
}

function anthropicSseResponse(run: (write: (chunk: string) => Promise<void>) => Promise<void>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = async (chunk: string) => {
        controller.enqueue(encoder.encode(chunk));
      };
      run(write)
        .catch((error) => {
          controller.enqueue(encoder.encode(sse("error", { type: "error", error: { type: "api_error", message: String(error?.message || error) } })));
        })
        .finally(() => controller.close());
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\n${sseData(data)}`;
}

function finishReasonToStopReason(reason: string | null): string {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "length") return "max_tokens";
  return "end_turn";
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

function makeToolId(): string {
  return makeResponsesId("toolu");
}

function anthropicToolUseId(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.startsWith("toolu_") ? text : makeToolId();
}
