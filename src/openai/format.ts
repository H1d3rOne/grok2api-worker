export function makeResponseId(prefix = "chatcmpl"): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}-${Date.now()}${hex}`;
}

export function makeResponsesId(prefix = "resp"): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${Date.now()}${hex}`;
}

export function estimateTokens(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 0;
  // Cheap approximation, close enough for Worker usage accounting fallback.
  return Math.max(1, Math.ceil(text.length / 4));
}

export function buildUsage(promptTokens: number, completionTokens: number, reasoningTokens = 0): Record<string, unknown> {
  const pt = Math.max(0, Math.trunc(promptTokens || 0));
  const ct = Math.max(0, Math.trunc(completionTokens || 0));
  const rt = Math.max(0, Math.trunc(reasoningTokens || 0));
  return {
    prompt_tokens: pt,
    completion_tokens: ct,
    total_tokens: pt + ct,
    prompt_tokens_details: {
      cached_tokens: 0,
      text_tokens: pt,
      audio_tokens: 0,
      image_tokens: 0,
    },
    completion_tokens_details: {
      text_tokens: Math.max(0, ct - rt),
      audio_tokens: 0,
      reasoning_tokens: rt,
    },
  };
}

export function makeStreamChunk(
  responseId: string,
  model: string,
  content: string | null,
  options: {
    index?: number;
    role?: string;
    isFinal?: boolean;
    finishReason?: string | null;
    usage?: Record<string, unknown> | null;
    annotations?: unknown[] | null;
  } = {},
): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  if (!options.isFinal) {
    delta.role = options.role || "assistant";
    delta.content = content;
  } else {
    if (content !== null && content !== undefined && content !== "") delta.content = content;
    if (options.annotations?.length) delta.annotations = options.annotations;
  }

  const choice: Record<string, unknown> = { index: options.index ?? 0, delta };
  if (options.isFinal) choice.finish_reason = options.finishReason || "stop";
  const chunk: Record<string, unknown> = {
    id: responseId,
    object: "chat.completion.chunk",
    created: nowSeconds(),
    model,
    choices: [choice],
  };
  if (options.usage) chunk.usage = options.usage;
  return chunk;
}

export function makeThinkingChunk(responseId: string, model: string, content: string): Record<string, unknown> {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", reasoning_content: content },
      },
    ],
  };
}

export function makeToolCallChunk(
  responseId: string,
  model: string,
  index: number,
  callId: string,
  name: string,
  args: string,
  isFirst: boolean,
): Record<string, unknown> {
  const toolCall = isFirst
    ? {
        index,
        id: callId,
        type: "function",
        function: { name, arguments: args },
      }
    : {
        index,
        function: { arguments: args },
      };
  return {
    id: responseId,
    object: "chat.completion.chunk",
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: null,
          tool_calls: [toolCall],
        },
      },
    ],
  };
}

export function makeToolCallDoneChunk(responseId: string, model: string, usage?: Record<string, unknown>): Record<string, unknown> {
  const chunk: Record<string, unknown> = {
    id: responseId,
    object: "chat.completion.chunk",
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "tool_calls",
      },
    ],
  };
  if (usage) chunk.usage = usage;
  return chunk;
}

export function makeChatResponse(
  model: string,
  content: string | null,
  options: {
    promptContent?: unknown;
    responseId?: string;
    usage?: Record<string, unknown> | null;
    reasoningContent?: string | null;
    searchSources?: unknown[] | null;
    annotations?: unknown[] | null;
  } = {},
): Record<string, unknown> {
  const responseId = options.responseId || makeResponseId();
  const reasoning = options.reasoningContent || "";
  const promptTokens = estimateTokens(options.promptContent || "");
  const completionTokens = estimateTokens(content || "") + estimateTokens(reasoning);
  const reasoningTokens = estimateTokens(reasoning);
  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (options.annotations?.length) message.annotations = options.annotations;

  const response: Record<string, unknown> = {
    id: responseId,
    object: "chat.completion",
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: "stop",
      },
    ],
    usage: options.usage || buildUsage(promptTokens, completionTokens, reasoningTokens),
  };
  if (options.searchSources?.length) response.search_sources = options.searchSources;
  return response;
}

export function makeToolCallResponse(
  model: string,
  toolCalls: unknown[],
  options: { promptContent?: unknown; responseId?: string; usage?: Record<string, unknown> | null } = {},
): Record<string, unknown> {
  const responseId = options.responseId || makeResponseId();
  return {
    id: responseId,
    object: "chat.completion",
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls,
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: options.usage || buildUsage(estimateTokens(options.promptContent || ""), estimateTokens(toolCalls)),
  };
}

export function makeResponsesObject(
  responseId: string,
  model: string,
  status: "completed" | "in_progress" | "failed",
  output: unknown[],
  usage?: Record<string, unknown> | null,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    id: responseId,
    object: "response",
    created_at: nowSeconds(),
    status,
    model,
    output,
  };
  if (usage) response.usage = usage;
  return response;
}

export function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
