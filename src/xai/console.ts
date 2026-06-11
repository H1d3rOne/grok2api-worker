import type { ChatMessage, Env } from "../types";
import { boolEnv, floatEnv } from "../config";
import { UpstreamError } from "../errors";
import { makeResponsesId } from "../openai/format";
import { buildHttpHeaders } from "./headers";
import { assertOk, fetchWithTimeout } from "./http";

export const CONSOLE_RESPONSES_URL = "https://console.x.ai/v1/responses";
export const CONSOLE_ORIGIN = "https://console.x.ai";

export interface ConsolePostArgs {
  token: string;
  consoleModel: string;
  input: unknown;
  instructions?: string;
  stream?: boolean;
  temperature?: number | null;
  topP?: number | null;
  reasoningEffort?: string | null;
  tools?: unknown[] | null;
  toolChoice?: unknown;
}

export function buildConsoleInput(messages: ChatMessage[]): { input: Array<Record<string, unknown>>; instructions: string } {
  const instructions: string[] = [];
  const output: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const role = msg.role || "user";
    const content = msg.content;
    const toolCalls = msg.tool_calls;

    if (role === "system" || role === "developer") {
      const text = flattenText(content);
      if (text.trim()) instructions.push(text.trim());
      continue;
    }

    if (role === "tool") {
      output.push({
        type: "function_call_output",
        call_id: msg.tool_call_id || "",
        output: flattenText(content) || "",
      });
      continue;
    }

    if (role === "assistant" && Array.isArray(toolCalls) && toolCalls.length) {
      for (const tc of toolCalls) {
        const fn = typeof tc.function === "object" && tc.function !== null ? (tc.function as Record<string, unknown>) : {};
        output.push({
          type: "function_call",
          call_id: String(tc.id || fn.name || ""),
          name: String(fn.name || ""),
          arguments: String(fn.arguments || "{}"),
        });
      }
      const text = flattenText(content);
      if (text.trim()) {
        output.push({ role: "assistant", content: [{ type: "output_text", text: text.trim() }] });
      }
      continue;
    }

    const blocks = convertContentBlocks(content, role);
    if (blocks.length) output.push({ role, content: blocks });
  }

  return { input: output, instructions: instructions.join("\n\n").trim() };
}

function flattenText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const row = block as Record<string, unknown>;
    if (row.type === "text" || row.type === "input_text" || row.type === "output_text") {
      const text = row.text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

function convertContentBlocks(content: unknown, role: string): Array<Record<string, unknown>> {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: textType, text }] : [];
  }
  if (!Array.isArray(content)) return [];

  const out: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const row = block as Record<string, unknown>;
    const type = row.type;
    if (type === "text") {
      const text = row.text;
      if (typeof text === "string" && text.trim()) out.push({ type: textType, text });
    } else if (type === "image_url") {
      const inner = row.image_url;
      let url = "";
      let detail = "auto";
      if (typeof inner === "string") url = inner;
      else if (inner && typeof inner === "object") {
        const obj = inner as Record<string, unknown>;
        url = typeof obj.url === "string" ? obj.url : "";
        detail = typeof obj.detail === "string" ? obj.detail : "auto";
      }
      if (url) out.push({ type: "input_image", image_url: url, detail });
    } else if (type === "input_text" || type === "output_text" || type === "input_image") {
      out.push({ ...row });
    }
  }
  return out;
}

export function convertOpenAIToolsToConsole(tools: unknown[] | null | undefined): unknown[] {
  if (!tools) return [];
  const out: unknown[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const row = t as Record<string, unknown>;
    if (row.type !== "function") {
      out.push({ ...row });
      continue;
    }
    const fn = row.function;
    if (fn && typeof fn === "object") {
      const f = fn as Record<string, unknown>;
      out.push({
        type: "function",
        name: f.name || "",
        description: f.description || "",
        parameters: f.parameters || {},
      });
    } else {
      out.push({ ...row });
    }
  }
  return out;
}

export function convertOpenAIToolChoice(choice: unknown): unknown {
  if (typeof choice === "string") return choice;
  if (choice && typeof choice === "object") {
    const row = choice as Record<string, unknown>;
    if (row.type === "function") {
      const fn = row.function;
      if (fn && typeof fn === "object") return { type: "function", name: (fn as Record<string, unknown>).name || "" };
    }
    return { ...row };
  }
  return choice;
}

export function injectWebSearchTool(env: Env, tools: unknown[]): unknown[] {
  if (!boolEnv(env, "CONSOLE_WEB_SEARCH", true)) return tools;
  if (tools.some((t) => !!t && typeof t === "object" && (t as Record<string, unknown>).type === "web_search")) return tools;
  return [...tools, { type: "web_search" }];
}

export function buildConsolePayload(env: Env, args: Omit<ConsolePostArgs, "token">): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: args.consoleModel,
    input: args.input,
  };
  if (args.stream) payload.stream = true;
  const custom = (env.CUSTOM_INSTRUCTION || "").trim();
  const userInstructions = (args.instructions || "").trim();
  const mergedInstructions = [custom, userInstructions].filter(Boolean).join("\n\n");
  if (mergedInstructions) payload.instructions = mergedInstructions;
  if (args.temperature !== undefined && args.temperature !== null) payload.temperature = args.temperature;
  if (args.topP !== undefined && args.topP !== null) payload.top_p = args.topP;
  if (args.reasoningEffort && args.reasoningEffort !== "none") {
    payload.reasoning = { effort: args.reasoningEffort === "xhigh" ? "high" : args.reasoningEffort };
  }
  if (args.tools?.length) {
    payload.tools = args.tools;
    if (args.toolChoice !== undefined && args.toolChoice !== null) payload.tool_choice = args.toolChoice;
  }
  return payload;
}

export async function postConsole(env: Env, args: ConsolePostArgs): Promise<Response> {
  const payload = buildConsolePayload(env, args);
  const timeoutMs = Math.max(1, floatEnv(env, "CHAT_TIMEOUT_SECONDS", 120)) * 1000;
  const response = await fetchWithTimeout(
    CONSOLE_RESPONSES_URL,
    {
      method: "POST",
      headers: buildHttpHeaders(args.token, env, {
        contentType: "application/json",
        origin: CONSOLE_ORIGIN,
        referer: `${CONSOLE_ORIGIN}/`,
      }),
      body: JSON.stringify(payload),
    },
    timeoutMs,
    env,
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw parseConsoleError(response.status, body);
  }
  return response;
}

export function parseConsoleError(statusCode: number, body: string): UpstreamError {
  let message = `Console upstream returned ${statusCode}`;
  try {
    const obj = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    const err = obj.error || obj.code;
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      message += `: ${e.message || e.code || JSON.stringify(e).slice(0, 160)}`;
    } else if (err) {
      message += `: ${String(err)}`;
    }
  } catch {
    // ignore
  }
  return new UpstreamError(message, statusCode, body.slice(0, 500));
}

export function extractConsoleText(responseJson: Record<string, unknown>): string {
  for (const item of asArray(responseJson.output)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type !== "message") continue;
    for (const content of asArray(row.content)) {
      if (!content || typeof content !== "object") continue;
      const c = content as Record<string, unknown>;
      if (c.type === "output_text" && typeof c.text === "string") return c.text;
    }
  }
  return "";
}

export function extractConsoleReasoning(responseJson: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const item of asArray(responseJson.output)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type !== "reasoning") continue;
    for (const s of asArray(row.summary)) {
      if (typeof s === "string") parts.push(s);
      else if (s && typeof s === "object") {
        const ss = s as Record<string, unknown>;
        if (typeof ss.text === "string") parts.push(ss.text);
        else if (typeof ss.content === "string") parts.push(ss.content);
      }
    }
  }
  return parts.join("\n");
}

export function extractConsoleToolCalls(responseJson: Record<string, unknown>): Array<Record<string, unknown>> {
  const calls: Array<Record<string, unknown>> = [];
  for (const item of asArray(responseJson.output)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type !== "function_call") continue;
    calls.push({
      id: normalizeOpenAIToolCallId(row.call_id || row.id),
      type: "function",
      function: {
        name: row.name || "",
        arguments: row.arguments || "{}",
      },
    });
  }
  return calls;
}

export interface ConsoleAnnotation {
  url: string;
  title: string;
  start_index: number;
  end_index: number;
}

export function extractConsoleAnnotations(responseJson: Record<string, unknown>): ConsoleAnnotation[] {
  const out: ConsoleAnnotation[] = [];
  for (const item of asArray(responseJson.output)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type !== "message") continue;
    for (const content of asArray(row.content)) {
      if (!content || typeof content !== "object") continue;
      for (const ann of asArray((content as Record<string, unknown>).annotations)) {
        if (!ann || typeof ann !== "object") continue;
        const a = ann as Record<string, unknown>;
        if (a.type && a.type !== "url_citation") continue;
        const url = typeof a.url === "string" ? a.url : "";
        if (!url) continue;
        out.push({
          url,
          title: typeof a.title === "string" && a.title !== url ? a.title : "",
          start_index: Number(a.start_index || 0),
          end_index: Number(a.end_index || 0),
        });
      }
    }
  }
  return out;
}

export function extractConsoleSearchSources(responseJson: Record<string, unknown>): Array<{ url: string; title: string }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; title: string }> = [];

  const add = (url: unknown, title: unknown = "") => {
    if (typeof url !== "string" || !url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, title: typeof title === "string" && title !== url ? title : "" });
  };

  for (const item of asArray(responseJson.output)) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (row.type === "web_search_call") {
      const action = row.action as Record<string, unknown> | undefined;
      for (const src of asArray(action?.sources)) {
        if (src && typeof src === "object") add((src as Record<string, unknown>).url, (src as Record<string, unknown>).title);
      }
      if (action?.type === "open_page") add(action.url);
    }
  }
  for (const ann of extractConsoleAnnotations(responseJson)) add(ann.url, ann.title);
  return out;
}

export function extractConsoleUsage(responseJson: Record<string, unknown>): Record<string, number> {
  const usage = (responseJson.usage || {}) as Record<string, unknown>;
  const details = (usage.output_tokens_details || {}) as Record<string, unknown>;
  return {
    prompt_tokens: Number(usage.input_tokens || 0),
    completion_tokens: Number(usage.output_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
    reasoning_tokens: Number(details.reasoning_tokens || usage.reasoning_tokens || 0),
  };
}

export function classifyConsoleSseLine(line: string | Uint8Array): ["data" | "event" | "skip", string] {
  let text = typeof line === "string" ? line : new TextDecoder().decode(line);
  text = text.trim();
  if (!text) return ["skip", ""];
  if (text.startsWith("event:")) return ["event", text.slice(6).trim()];
  if (text.startsWith("data:")) return ["data", text.slice(5).trim()];
  if (text.startsWith("{")) return ["data", text];
  return ["skip", ""];
}

export class ConsoleStreamAdapter {
  private currentEvent = "";
  private activeToolIndex = new Map<string, number>();
  private toolArgsBuf = new Map<string, string[]>();
  private seenSourceUrls = new Set<string>();
  private usageData: Record<string, number> = {};

  public toolCalls: Array<Record<string, unknown>> = [];
  public annotations: ConsoleAnnotation[] = [];
  public searchSources: Array<{ url: string; title: string }> = [];
  public textBuf: string[] = [];
  public thinkingBuf: string[] = [];

  feedEvent(eventName: string): void {
    this.currentEvent = eventName;
  }

  feedData(data: string): Record<string, unknown> {
    if (!data || data === "[DONE]") return { kind: "done" };
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return { kind: "skip" };
    }
    const ev = this.currentEvent || String(obj.type || "");

    if (ev === "response.output_text.delta" || obj.type === "response.output_text.delta") {
      const delta = obj.delta;
      if (typeof delta === "string" && delta) {
        this.textBuf.push(delta);
        return { kind: "text", content: delta };
      }
      return { kind: "skip" };
    }

    if (
      ev === "response.reasoning_summary_text.delta" ||
      ev === "response.reasoning_summary.delta" ||
      obj.type === "response.reasoning_summary_text.delta" ||
      obj.type === "response.reasoning_summary.delta"
    ) {
      const delta = obj.delta;
      if (typeof delta === "string" && delta) {
        this.thinkingBuf.push(delta);
        return { kind: "thinking", content: delta };
      }
      return { kind: "skip" };
    }

    if (ev === "response.output_item.added" || obj.type === "response.output_item.added") {
      const item = obj.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        const itemId = String(item.id || item.call_id || "");
        const callId = normalizeOpenAIToolCallId(item.call_id || itemId);
        const name = String(item.name || "");
        const index = this.toolCalls.length;
        this.activeToolIndex.set(itemId, index);
        this.toolArgsBuf.set(itemId, []);
        this.toolCalls.push({ id: callId, type: "function", function: { name, arguments: "" } });
        return { kind: "tool_call_start", index, call_id: callId, name };
      }
      return { kind: "skip" };
    }

    if (ev === "response.output_item.done" || obj.type === "response.output_item.done") {
      const item = obj.item as Record<string, unknown> | undefined;
      if (item?.type === "web_search_call") {
        const action = item.action as Record<string, unknown> | undefined;
        for (const src of asArray(action?.sources)) {
          if (src && typeof src === "object") this.addSource((src as Record<string, unknown>).url, (src as Record<string, unknown>).title);
        }
        if (action?.type === "open_page") this.addSource(action.url, "");
      }
      return { kind: "skip" };
    }

    if (ev === "response.function_call_arguments.delta" || obj.type === "response.function_call_arguments.delta") {
      const itemId = String(obj.item_id || "");
      const delta = obj.delta;
      const index = this.activeToolIndex.get(itemId);
      if (index === undefined || typeof delta !== "string" || !delta) return { kind: "skip" };
      this.toolArgsBuf.get(itemId)?.push(delta);
      return { kind: "tool_call_args", index, delta };
    }

    if (ev === "response.function_call_arguments.done" || obj.type === "response.function_call_arguments.done") {
      const itemId = String(obj.item_id || "");
      const index = this.activeToolIndex.get(itemId);
      if (index === undefined) return { kind: "skip" };
      const finalArgs = typeof obj.arguments === "string" && obj.arguments ? obj.arguments : (this.toolArgsBuf.get(itemId) || []).join("");
      const call = this.toolCalls[index] as Record<string, unknown> | undefined;
      const fn = call?.function as Record<string, unknown> | undefined;
      if (fn) fn.arguments = finalArgs;
      return { kind: "tool_call_done", index };
    }

    if (ev === "response.output_text.annotation.added" || obj.type === "response.output_text.annotation.added") {
      const ann = obj.annotation as Record<string, unknown> | undefined;
      if (ann && (!ann.type || ann.type === "url_citation") && typeof ann.url === "string" && ann.url) {
        const record = {
          url: ann.url,
          title: typeof ann.title === "string" && ann.title !== ann.url ? ann.title : "",
          start_index: Number(ann.start_index || 0),
          end_index: Number(ann.end_index || 0),
        };
        this.annotations.push(record);
        this.addSource(record.url, record.title);
        return { kind: "annotation", annotation_data: record };
      }
      return { kind: "skip" };
    }

    if (ev === "response.completed" || obj.type === "response.completed") {
      const resp = (obj.response || obj) as Record<string, unknown>;
      this.usageData = extractConsoleUsage(resp);
      return { kind: "done" };
    }

    if (["response.failed", "response.error", "error"].includes(ev) || ["response.failed", "response.error", "error"].includes(String(obj.type || ""))) {
      const err = (obj.error || (obj.response as Record<string, unknown> | undefined)?.error || {}) as Record<string, unknown> | string;
      const message = typeof err === "object" ? String(err.message || err.code || "Console stream error") : String(err || "Console stream error");
      return { kind: "error", message };
    }

    return { kind: "skip" };
  }

  usage(): Record<string, number> {
    return { ...this.usageData };
  }

  referencesSuffix(env: Env): string {
    if (!boolEnv(env, "SHOW_SEARCH_SOURCES", false) || !this.searchSources.length) return "";
    const lines = ["\n\n## Sources", "[grok2api-sources]: #"];
    for (const item of this.searchSources) {
      const title = (item.title || item.url).replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      lines.push(`- [${title}](${item.url})`);
    }
    return `${lines.join("\n")}\n`;
  }

  private addSource(url: unknown, title: unknown): void {
    if (typeof url !== "string" || !url || this.seenSourceUrls.has(url)) return;
    this.seenSourceUrls.add(url);
    this.searchSources.push({ url, title: typeof title === "string" && title !== url ? title : "" });
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeOpenAIToolCallId(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.startsWith("call_") ? text : makeResponsesId("call");
}
