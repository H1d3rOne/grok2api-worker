import type { Env } from "../types";
import type { ModeId } from "../models";
import { boolEnv } from "../config";
import { UpstreamError } from "../errors";
import { buildHttpHeaders } from "./headers";
import { assertOk, fetchWithTimeout } from "./http";

export const GROK_ORIGIN = "https://grok.com";
export const GROK_CHAT_URL = "https://grok.com/rest/app-chat/conversations/new";
export const ASSETS_BASE = "https://assets.grok.com/";

export interface FrameEvent {
  kind: "text" | "thinking" | "image" | "image_progress" | "annotation" | "soft_stop" | "skip";
  content?: string;
  imageId?: string;
  annotationData?: UrlCitation;
}

export interface UrlCitation {
  type?: "url_citation";
  url: string;
  title: string;
  start_index: number;
  end_index: number;
}

export interface SearchSource {
  url: string;
  title: string;
  type?: string;
}

export function buildChatPayload(
  env: Env,
  args: {
    message: string;
    modeId: ModeId;
    fileAttachments?: string[];
    toolOverrides?: Record<string, unknown> | null;
    modelConfigOverride?: Record<string, unknown> | null;
    requestOverrides?: Record<string, unknown> | null;
  },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    collectionIds: [],
    connectors: [],
    deviceEnvInfo: {
      darkModeEnabled: false,
      devicePixelRatio: 2,
      screenHeight: 1329,
      screenWidth: 2056,
      viewportHeight: 1083,
      viewportWidth: 2056,
    },
    disableMemory: !boolEnv(env, "MEMORY", false),
    disableSearch: false,
    disableSelfHarmShortCircuit: false,
    disableTextFollowUps: false,
    enableImageGeneration: true,
    enableImageStreaming: true,
    enableSideBySide: true,
    fileAttachments: args.fileAttachments || [],
    forceConcise: false,
    forceSideBySide: false,
    imageAttachments: [],
    imageGenerationCount: 2,
    isAsyncChat: false,
    message: args.message,
    modeId: args.modeId,
    responseMetadata: {},
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    searchAllConnectors: false,
    sendFinalMetadata: true,
    temporary: boolEnv(env, "TEMPORARY", true),
    toolOverrides: args.toolOverrides || {
      gmailSearch: false,
      googleCalendarSearch: false,
      outlookSearch: false,
      outlookCalendarSearch: false,
      googleDriveSearch: false,
    },
  };

  const custom = (env.CUSTOM_INSTRUCTION || "").trim();
  if (custom) payload.customPersonality = custom;
  if (args.modelConfigOverride) {
    (payload.responseMetadata as Record<string, unknown>).modelConfigOverride = args.modelConfigOverride;
  }
  if (args.requestOverrides) {
    for (const [key, value] of Object.entries(args.requestOverrides)) {
      if (value !== undefined && value !== null) payload[key] = value;
    }
  }
  return payload;
}

export async function postGrokChat(
  env: Env,
  token: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Response> {
  const response = await fetchWithTimeout(
    GROK_CHAT_URL,
    {
      method: "POST",
      headers: buildHttpHeaders(token, env, {
        contentType: "application/json",
        origin: GROK_ORIGIN,
        referer: `${GROK_ORIGIN}/`,
      }),
      body: JSON.stringify(payload),
    },
    timeoutMs,
    env,
  );
  return assertOk(response, "Chat upstream");
}

export function classifyLine(line: string | Uint8Array): ["data" | "done" | "skip", string] {
  let text = typeof line === "string" ? line : new TextDecoder().decode(line);
  text = text.trim();
  if (!text) return ["skip", ""];
  if (text.startsWith("data:")) {
    const data = text.slice(5).trim();
    if (data === "[DONE]") return ["done", ""];
    return ["data", data];
  }
  if (text.startsWith("event:")) return ["skip", ""];
  if (text.startsWith("{")) return ["data", text];
  return ["skip", ""];
}

function upstreamErrorFromPayload(obj: Record<string, unknown>): UpstreamError | null {
  const error = obj.error;
  if (!error || typeof error !== "object") return null;
  const err = error as Record<string, unknown>;
  const message = String(err.message || err.error || "Upstream stream error");
  const code = err.code;
  const text = message.toLowerCase();
  const status = code === 8 || text.includes("too many requests") || text.includes("rate limit") ? 429 : 502;
  return new UpstreamError(`Upstream stream error: ${message}`, status, JSON.stringify(obj).slice(0, 500));
}

function raiseForStreamError(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;
  const err = upstreamErrorFromPayload(obj as Record<string, unknown>);
  if (err) throw err;
}

const GROK_RENDER_RE = /<grok:render\s+card_id="([^"]+)"\s+card_type="([^"]+)"\s+type="([^"]+)"[^>]*>.*?<\/grok:render>/gs;

export class StreamAdapter {
  private cardCache = new Map<string, Record<string, unknown>>();
  private citationOrder: string[] = [];
  private citationMap = new Map<string, number>();
  private lastCitationIndex = -1;
  private pendingCitations: Array<{ url: string; title: string; needle: string }> = [];
  private annotations: UrlCitation[] = [];
  private textOffset = 0;
  private emittedReasoningKeys = new Set<string>();
  private lastRollout = "";
  private contentStarted = false;
  private webSearchResults: SearchSource[] = [];
  private webSearchUrlsSeen = new Set<string>();

  public thinkingBuf: string[] = [];
  public textBuf: string[] = [];
  public imageUrls: Array<{ url: string; imageId: string }> = [];

  constructor(private env: Env) {}

  feed(data: string): FrameEvent[] {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return [];
    }
    raiseForStreamError(obj);

    const result = obj.result as Record<string, unknown> | undefined;
    const resp = result?.response as Record<string, unknown> | undefined;
    if (!resp) return [];

    const events: FrameEvent[] = [];
    const cardRaw = resp.cardAttachment as Record<string, unknown> | undefined;
    if (cardRaw) events.push(...this.handleCard(cardRaw));

    this.collectWebSources(resp.webSearchResults as Record<string, unknown> | undefined);
    this.collectXSources(resp.xSearchResults as Record<string, unknown> | undefined);

    const token = resp.token;
    const isThinking = resp.isThinking;
    const tag = String(resp.messageTag || "");
    const rollout = typeof resp.rolloutId === "string" ? resp.rolloutId : "";
    const stepId = typeof resp.messageStepId === "number" ? resp.messageStepId : undefined;

    if (tag === "tool_usage_card") {
      if (this.contentStarted) return events;
      const line = this.formatToolCard(resp, rollout);
      if (line) this.appendReasoning(events, line, rollout, tag, stepId);
      return events;
    }

    if (tag === "raw_function_result") return events;
    if (resp.toolUsageCardId && !resp.webSearchResults && !resp.codeExecutionResult) return events;

    if (token !== undefined && token !== null && isThinking === true) {
      if (this.contentStarted) {
        const raw = String(token).trim();
        if (raw) this.thinkingBuf.push(raw.endsWith("\n") ? raw : `${raw}\n`);
        return events;
      }
      let raw = String(token);
      if (raw.startsWith("- ")) raw = raw.slice(2);
      if (!raw) return events;
      if (rollout && rollout !== this.lastRollout) {
        this.lastRollout = rollout;
        const header = `\n[${rollout}]\n`;
        this.thinkingBuf.push(header);
        events.push({ kind: "thinking", content: header });
      }
      this.appendReasoning(events, raw, rollout, tag, stepId);
      return events;
    }

    if (token !== undefined && token !== null && isThinking !== true && tag === "final") {
      this.contentStarted = true;
      const [cleaned, localAnnotations] = this.cleanToken(String(token));
      if (cleaned) {
        this.textBuf.push(cleaned);
        events.push({ kind: "text", content: cleaned });
        for (const ann of localAnnotations) {
          const record: UrlCitation = {
            type: "url_citation",
            url: ann.url,
            title: ann.title,
            start_index: this.textOffset + ann.localStart,
            end_index: this.textOffset + ann.localEnd,
          };
          this.annotations.push(record);
          events.push({ kind: "annotation", annotationData: record });
        }
        this.textOffset += cleaned.length;
      }
      return events;
    }

    if (resp.isSoftStop || resp.finalMetadata) {
      events.push({ kind: "soft_stop" });
      return events;
    }

    return events;
  }

  annotationsList(): UrlCitation[] {
    return [...this.annotations];
  }

  searchSourcesList(): SearchSource[] | undefined {
    if (!this.webSearchResults.length) return undefined;
    return this.webSearchResults.map((item) => ({
      url: item.url,
      title: item.title || item.url,
      type: item.type || "web",
    }));
  }

  referencesSuffix(): string {
    if (!boolEnv(this.env, "SHOW_SEARCH_SOURCES", false)) return "";
    const sources = this.searchSourcesList();
    if (!sources?.length) return "";
    const lines = ["\n\n## Sources", "[grok2api-sources]: #"];
    for (const item of sources) {
      const title = (item.title || item.url).replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
      lines.push(`- [${title}](${item.url})`);
    }
    return `${lines.join("\n")}\n`;
  }

  private handleCard(cardRaw: Record<string, unknown>): FrameEvent[] {
    const jsonData = cardRaw.jsonData;
    if (typeof jsonData !== "string") return [];
    let card: Record<string, unknown>;
    try {
      card = JSON.parse(jsonData) as Record<string, unknown>;
    } catch {
      return [];
    }
    const id = String(card.id || "");
    if (id) this.cardCache.set(id, card);

    const chunk = card.image_chunk as Record<string, unknown> | undefined;
    if (!chunk) return [];
    const events: FrameEvent[] = [];
    const progress = Number(chunk.progress);
    const imageId = String(chunk.imageUuid || "");
    if (Number.isFinite(progress)) events.push({ kind: "image_progress", content: String(Math.trunc(progress)), imageId });
    if (progress === 100 && !chunk.moderated && typeof chunk.imageUrl === "string") {
      const url = ASSETS_BASE + chunk.imageUrl;
      this.imageUrls.push({ url, imageId });
      events.push({ kind: "image", content: url, imageId });
    }
    return events;
  }

  private collectWebSources(wsr: Record<string, unknown> | undefined): void {
    const results = Array.isArray(wsr?.results) ? wsr.results : [];
    for (const item of results) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const url = typeof row.url === "string" ? row.url : "";
      if (!url || this.webSearchUrlsSeen.has(url)) continue;
      this.webSearchUrlsSeen.add(url);
      this.webSearchResults.push({
        url,
        title: typeof row.title === "string" ? row.title : url,
        type: "web",
      });
    }
  }

  private collectXSources(xsr: Record<string, unknown> | undefined): void {
    const results = Array.isArray(xsr?.results) ? xsr.results : [];
    for (const item of results) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const postId = row.postId;
      const username = row.username;
      if (!postId || !username) continue;
      const url = `https://x.com/${username}/status/${postId}`;
      if (this.webSearchUrlsSeen.has(url)) continue;
      this.webSearchUrlsSeen.add(url);
      const rawText = typeof row.text === "string" ? row.text.replace(/\s+/g, " ").trim() : "";
      this.webSearchResults.push({
        url,
        title: rawText ? `𝕏/@${username}: ${rawText.slice(0, 50)}${rawText.length > 50 ? "..." : ""}` : `𝕏/@${username}`,
        type: "x_post",
      });
    }
  }

  private cleanToken(token: string): [string, Array<{ url: string; title: string; localStart: number; localEnd: number }>] {
    if (!token.includes("<grok:render")) return [token, []];
    let cleaned = token.replace(GROK_RENDER_RE, (match, cardId: string, _cardType: string, renderType: string) =>
      this.renderReplace(cardId, renderType),
    );
    if (cleaned.startsWith("\n") && cleaned.includes("[[")) cleaned = cleaned.replace(/^\n+/, "");

    const anns: Array<{ url: string; title: string; localStart: number; localEnd: number }> = [];
    let searchStart = 0;
    for (const cite of this.pendingCitations) {
      const pos = cleaned.indexOf(cite.needle, searchStart);
      if (pos !== -1) {
        anns.push({ url: cite.url, title: cite.title, localStart: pos, localEnd: pos + cite.needle.length });
        searchStart = pos + cite.needle.length;
      }
    }
    this.pendingCitations = [];
    return [cleaned, anns];
  }

  private renderReplace(cardId: string, renderType: string): string {
    const card = this.cardCache.get(cardId);
    if (!card) return "";
    if (renderType === "render_searched_image") {
      const img = card.image as Record<string, unknown> | undefined;
      const title = String(img?.title || "image");
      const thumb = String(img?.thumbnail || img?.original || "");
      const link = String(img?.link || "");
      return link ? `[![${title}](${thumb})](${link})` : `![${title}](${thumb})`;
    }
    if (renderType === "render_generated_image") return "";
    if (renderType === "render_inline_citation") {
      const url = String(card.url || "");
      if (!url) return "";
      let index = this.citationMap.get(url);
      if (!index) {
        this.citationOrder.push(url);
        index = this.citationOrder.length;
        this.citationMap.set(url, index);
      }
      if (index === this.lastCitationIndex) return "";
      this.lastCitationIndex = index;
      const citationText = ` [[${index}]](${url})`;
      let title = typeof card.title === "string" ? card.title : "";
      if (!title) title = this.webSearchResults.find((item) => item.url === url)?.title || url;
      this.pendingCitations.push({ url, title, needle: citationText });
      return citationText;
    }
    return "";
  }

  private appendReasoning(events: FrameEvent[], line: string, rollout: string, tag: string, stepId?: number): void {
    const text = line;
    if (!text) return;
    const key = `${rollout}:${tag}:${stepId ?? ""}:${text}`;
    if (this.emittedReasoningKeys.has(key)) return;
    this.emittedReasoningKeys.add(key);
    const formatted = text.endsWith("\n") ? text : `${text}\n`;
    this.thinkingBuf.push(formatted);
    events.push({ kind: "thinking", content: formatted });
  }

  private formatToolCard(resp: Record<string, unknown>, rollout: string): string {
    const toolCard = resp.toolUsageCard as Record<string, unknown> | undefined;
    if (!toolCard) return "";
    for (const [key, value] of Object.entries(toolCard)) {
      if (key === "toolUsageCardId" || !value || typeof value !== "object") continue;
      const toolName = key.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
      const args = (value as Record<string, unknown>).args as Record<string, unknown> | undefined;
      const display = ["query", "q", "url", "image_description", "imageDescription", "message"]
        .map((k) => args?.[k])
        .find((v) => typeof v === "string" && v.trim());
      const prefix = rollout ? `[${rollout}] ` : "";
      return `${prefix}🔧 ${toolName}${display ? `: ${display}` : ""}`;
    }
    return "";
  }
}
