export interface ParsedToolCall {
  call_id: string;
  name: string;
  arguments: string;
}

export interface ParseResult {
  calls: ParsedToolCall[];
  sawToolSyntax: boolean;
}

const TOOL_SYSTEM_HEADER = `You have access to the following tools.

AVAILABLE TOOLS:
{tool_definitions}

TOOL CALL FORMAT — follow these rules exactly:
- When calling a tool, output ONLY the XML block below. No text before or after it.
- <parameters> must be a single-line valid JSON object (no line breaks inside).
- Place multiple tool calls inside ONE <tool_calls> element.
- Do NOT use markdown code fences around the XML.
- Do NOT output any inner monologue or explanation alongside the XML.

<tool_calls>
  <tool_call>
    <tool_name>TOOL_NAME</tool_name>
    <parameters>{"key": "value"}</parameters>
  </tool_call>
</tool_calls>

WRONG (never do this):
\`\`\`xml
<tool_calls>...</tool_calls>
\`\`\`
I'll call the search tool now. <tool_calls>...</tool_calls>

{tool_choice_instruction}
NOTE: Even if you believe you cannot fulfill the request, you must still follow the WHEN TO CALL rule above.`;

const CHOICE_AUTO = "WHEN TO CALL: Call a tool when it is clearly needed. Otherwise respond in plain text.";
const CHOICE_NONE = "WHEN TO CALL: Do NOT call any tools. Respond in plain text only.";
const CHOICE_REQUIRED =
  "WHEN TO CALL: You MUST output a <tool_calls> XML block. Do NOT write any plain-text reply. If you are uncertain, still call the most relevant tool with your best guess at the parameters.";
const CHOICE_FORCED = (name: string) =>
  `WHEN TO CALL: You MUST output a <tool_calls> XML block calling the tool named "${name}". Do NOT write any plain-text reply under any circumstances.`;

export function buildToolSystemPrompt(tools: Array<Record<string, unknown>>, toolChoice: unknown = null): string {
  return TOOL_SYSTEM_HEADER.replace("{tool_definitions}", formatToolDefinitions(tools)).replace(
    "{tool_choice_instruction}",
    buildChoiceInstruction(toolChoice),
  );
}

export function extractToolNames(tools: Array<Record<string, unknown>>): string[] {
  const names: string[] = [];
  for (const tool of tools) {
    const fn = tool.function && typeof tool.function === "object" ? (tool.function as Record<string, unknown>) : null;
    const name = String((fn ? fn.name : tool.name) || "").trim();
    if (name) names.push(name);
  }
  return names;
}

export function injectIntoMessage(message: string, systemPrompt: string): string {
  return `[system]: ${systemPrompt}\n\n${message}`;
}

export function toolCallsToXml(toolCalls: Array<Record<string, unknown>>): string {
  const lines = ["<tool_calls>"];
  for (const tc of toolCalls) {
    const fn = tc.function && typeof tc.function === "object" ? (tc.function as Record<string, unknown>) : {};
    const name = String(fn.name || "");
    let args = String(fn.arguments || "{}");
    try {
      args = JSON.stringify(JSON.parse(args));
    } catch {
      // Preserve non-JSON arguments exactly as supplied by the client.
    }
    lines.push("  <tool_call>");
    lines.push(`    <tool_name>${escapeXmlText(name)}</tool_name>`);
    lines.push(`    <parameters>${escapeXmlText(args)}</parameters>`);
    lines.push("  </tool_call>");
  }
  lines.push("</tool_calls>");
  return lines.join("\n");
}

export function parseToolCalls(text: string, availableTools: string[] = []): ParseResult {
  const result: ParseResult = { calls: [], sawToolSyntax: false };
  if (!text.trim()) return result;
  if (!hasToolSyntax(text)) return result;
  result.sawToolSyntax = true;

  let calls = parseXmlToolCalls(text);
  if (!calls.length) calls = parseJsonEnvelope(text);
  if (!calls.length) calls = parseJsonArray(text);
  if (!calls.length) calls = parseAltXml(text);

  if (calls.length && availableTools.length) {
    const allow = new Set(availableTools);
    calls = calls.filter((call) => allow.has(call.name));
  }
  result.calls = calls;
  return result;
}

export function parsedToolCallsToOpenAI(calls: ParsedToolCall[]): Array<Record<string, unknown>> {
  return calls.map((call) => ({
    id: call.call_id,
    type: "function",
    function: {
      name: call.name,
      arguments: call.arguments,
    },
  }));
}

export class ToolSieve {
  private buf = "";
  private capturing = false;
  private done = false;

  constructor(private toolNames: string[]) {}

  feed(chunk: string): [safeText: string, toolCalls: ParsedToolCall[] | null] {
    if (this.done || !chunk) return [this.capturing ? "" : chunk, null];
    if (this.capturing) return this.feedCapturing(chunk);
    return this.feedScanning(chunk);
  }

  flush(): ParsedToolCall[] | null {
    if (this.done || !this.buf) return null;
    this.done = true;
    const result = parseToolCalls(this.buf, this.toolNames);
    this.buf = "";
    return result.sawToolSyntax ? result.calls : null;
  }

  private feedScanning(chunk: string): [string, ParsedToolCall[] | null] {
    const combined = this.buf + chunk;
    this.buf = "";

    const match = /<tool_calls[\s>]?/i.exec(combined);
    if (!match) {
      const [safe, leftover] = splitAtBoundary(combined, "<tool_calls");
      this.buf = leftover;
      return [safe, null];
    }

    const safePart = combined.slice(0, match.index);
    this.buf = combined.slice(match.index);
    this.capturing = true;
    const [capSafe, calls] = this.feedCapturing("");
    return [safePart + capSafe, calls];
  }

  private feedCapturing(chunk: string): [string, ParsedToolCall[] | null] {
    this.buf += chunk;
    const close = /<\/tool_calls\s*>/i.exec(this.buf);
    if (!close) return ["", null];

    const xmlBlock = this.buf.slice(0, close.index + close[0].length);
    this.buf = "";
    this.capturing = false;
    this.done = true;

    const result = parseToolCalls(xmlBlock, this.toolNames);
    return ["", result.sawToolSyntax ? result.calls : null];
  }
}

function formatToolDefinitions(tools: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const tool of tools) {
    const fn = tool.function && typeof tool.function === "object" ? (tool.function as Record<string, unknown>) : tool;
    const name = String(fn.name || "").trim();
    const desc = String(fn.description || "").trim();
    const params = fn.parameters ?? fn.input_schema;
    const lines = [`Tool: ${name}`];
    if (desc) lines.push(`Description: ${desc}`);
    if (params !== undefined && params !== null) {
      try {
        lines.push(`Parameters: ${JSON.stringify(params)}`);
      } catch {
        lines.push(`Parameters: ${String(params)}`);
      }
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

function buildChoiceInstruction(toolChoice: unknown): string {
  if (toolChoice === undefined || toolChoice === null || toolChoice === "auto") return CHOICE_AUTO;
  if (toolChoice === "none") return CHOICE_NONE;
  if (toolChoice === "required") return CHOICE_REQUIRED;
  if (toolChoice && typeof toolChoice === "object") {
    const row = toolChoice as Record<string, unknown>;
    if (row.type === "none") return CHOICE_NONE;
    if (row.type === "required") return CHOICE_REQUIRED;
    if (row.type === "function") {
      const fn = row.function && typeof row.function === "object" ? (row.function as Record<string, unknown>) : {};
      const name = String(fn.name || "").trim();
      if (name) return CHOICE_FORCED(name);
    }
  }
  return CHOICE_AUTO;
}

function hasToolSyntax(text: string): boolean {
  return /<tool_calls|<tool_call|<function_call|<invoke\s|"tool_calls"\s*:|\btool_calls\b/i.test(text);
}

function parseXmlToolCalls(text: string): ParsedToolCall[] {
  const root = /<tool_calls\s*>([\s\S]*?)<\/tool_calls\s*>/i.exec(text);
  if (!root) return [];
  const calls: ParsedToolCall[] = [];
  const callRe = /<tool_call\s*>([\s\S]*?)<\/tool_call\s*>/gi;
  let callMatch: RegExpExecArray | null;
  const rootBody = root[1] || "";
  while ((callMatch = callRe.exec(rootBody))) {
    const inner = callMatch[1] || "";
    const name = /<tool_name\s*>([\s\S]*?)<\/tool_name\s*>/i.exec(inner)?.[1]?.trim() || "";
    const paramsRaw = /<parameters\s*>([\s\S]*?)<\/parameters\s*>/i.exec(inner)?.[1]?.trim() || "{}";
    if (!name) continue;
    const parsed = parseJsonTolerant(unescapeXmlText(paramsRaw));
    if (parsed === undefined) continue;
    calls.push(makeParsedToolCall(unescapeXmlText(name), parsed));
  }
  return calls;
}

function parseJsonEnvelope(text: string): ParsedToolCall[] {
  if (!text.includes('"tool_calls"')) return [];
  const obj = extractOutermostJsonObject(text);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  const rawCalls = (obj as Record<string, unknown>).tool_calls;
  return Array.isArray(rawCalls) ? extractFromCallList(rawCalls) : [];
}

function parseJsonArray(text: string): ParsedToolCall[] {
  const match = /\[[\s\S]+\]/.exec(text);
  if (!match) return [];
  try {
    const arr = JSON.parse(match[0]) as unknown;
    return Array.isArray(arr) ? extractFromCallList(arr) : [];
  } catch {
    return [];
  }
}

function parseAltXml(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const fcRe = /<function_call\s*>([\s\S]*?)<\/function_call\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = fcRe.exec(text))) {
    const inner = match[1] || "";
    const name = /<name\s*>([\s\S]*?)<\/name\s*>/i.exec(inner)?.[1]?.trim() || "";
    const argsRaw = /<arguments\s*>([\s\S]*?)<\/arguments\s*>/i.exec(inner)?.[1]?.trim() || "{}";
    if (!name) continue;
    const parsed = parseJsonTolerant(unescapeXmlText(argsRaw));
    calls.push(makeParsedToolCall(unescapeXmlText(name), parsed ?? {}));
  }

  const invokeRe = /<invoke\s+name=["']?(\w+)["']?\s*>([\s\S]*?)<\/invoke\s*>/gi;
  while ((match = invokeRe.exec(text))) {
    const name = (match[1] || "").trim();
    const parsed = parseJsonTolerant(unescapeXmlText((match[2] || "").trim()));
    calls.push(makeParsedToolCall(name, parsed ?? {}));
  }
  return calls;
}

function extractFromCallList(items: unknown[]): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = String(row.name || row.tool_name || "").trim();
    const args = row.input ?? row.arguments ?? row.parameters ?? {};
    if (name) calls.push(makeParsedToolCall(name, args));
  }
  return calls;
}

function extractOutermostJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      // Try a shorter candidate.
    }
  }
  return null;
}

function parseJsonTolerant(value: string): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    try {
      return JSON.parse(value.replace(/(?<!\\)\n/g, "\\n")) as unknown;
    } catch {
      return undefined;
    }
  }
}

function makeParsedToolCall(name: string, args: unknown): ParsedToolCall {
  let argText: string;
  if (typeof args === "string") {
    argText = args;
  } else {
    try {
      argText = JSON.stringify(args ?? {});
    } catch {
      argText = "{}";
    }
  }
  return {
    call_id: makeToolCallId(),
    name,
    arguments: argText,
  };
}

function makeToolCallId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `call_${Date.now()}${hex}`;
}

function splitAtBoundary(text: string, prefix: string): [string, string] {
  for (let i = Math.min(prefix.length - 1, text.length); i > 0; i--) {
    if (text.endsWith(prefix.slice(0, i))) return [text.slice(0, -i), text.slice(-i)];
  }
  return [text, ""];
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXmlText(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
