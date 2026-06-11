import type { Env } from "./types";
import type { PoolName } from "./config";
import { boolEnv } from "./config";
import { ApiError } from "./errors";
import { hasAnyTokenForPools } from "./token-pool";

export type ModeId = "auto" | "fast" | "expert" | "heavy" | "grok-420-computer-use-sa";
export type Tier = "basic" | "super" | "heavy";
export type Capability = "chat" | "image" | "image_edit" | "video";
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const REASONING_EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_CHAT_REASONING_EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

export interface ModelSpec {
  id: string;
  modeId: ModeId;
  tier: Tier;
  capability: Capability;
  enabled: boolean;
  name: string;
  preferBest?: boolean;
  consoleModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts?: ReasoningEffort[];
}

export const MODELS: ModelSpec[] = [
  { id: "grok-4.20-0309-non-reasoning", modeId: "fast", tier: "basic", capability: "chat", enabled: true, name: "Grok 4.20 0309 Non-Reasoning" },
  { id: "grok-4.20-0309", modeId: "auto", tier: "super", capability: "chat", enabled: true, name: "Grok 4.20 0309" },
  { id: "grok-4.20-0309-reasoning", modeId: "expert", tier: "super", capability: "chat", enabled: true, name: "Grok 4.20 0309 Reasoning" },
  { id: "grok-4.20-0309-non-reasoning-super", modeId: "fast", tier: "super", capability: "chat", enabled: true, name: "Grok 4.20 0309 Non-Reasoning Super" },
  { id: "grok-4.20-0309-super", modeId: "auto", tier: "super", capability: "chat", enabled: true, name: "Grok 4.20 0309 Super" },
  { id: "grok-4.20-0309-reasoning-super", modeId: "expert", tier: "super", capability: "chat", enabled: true, name: "Grok 4.20 0309 Reasoning Super" },
  { id: "grok-4.20-0309-non-reasoning-heavy", modeId: "fast", tier: "heavy", capability: "chat", enabled: true, name: "Grok 4.20 0309 Non-Reasoning Heavy" },
  { id: "grok-4.20-0309-heavy", modeId: "auto", tier: "heavy", capability: "chat", enabled: true, name: "Grok 4.20 0309 Heavy" },
  { id: "grok-4.20-0309-reasoning-heavy", modeId: "expert", tier: "heavy", capability: "chat", enabled: true, name: "Grok 4.20 0309 Reasoning Heavy" },
  { id: "grok-4.20-multi-agent-0309", modeId: "heavy", tier: "heavy", capability: "chat", enabled: true, name: "Grok 4.20 Multi-Agent 0309" },

  { id: "grok-4.20-fast", modeId: "fast", tier: "basic", capability: "chat", enabled: true, name: "Grok 4.20 Fast", preferBest: true },
  { id: "grok-4.20-auto", modeId: "auto", tier: "super", capability: "chat", enabled: true, name: "Grok 4.20 Auto", preferBest: true },
  { id: "grok-4.20-expert", modeId: "expert", tier: "super", capability: "chat", enabled: true, name: "Grok 4.20 Expert", preferBest: true },
  { id: "grok-4.20-heavy", modeId: "heavy", tier: "heavy", capability: "chat", enabled: true, name: "Grok 4.20 Heavy", preferBest: true },

  { id: "grok-4.3-beta", modeId: "grok-420-computer-use-sa", tier: "super", capability: "chat", enabled: true, name: "Grok 4.3 Beta" },

  {
    id: "grok-4.3",
    modeId: "fast",
    tier: "basic",
    capability: "chat",
    enabled: true,
    name: "Grok 4.3 (Console)",
    consoleModel: "grok-4.3",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  {
    id: "grok-4",
    modeId: "fast",
    tier: "basic",
    capability: "chat",
    enabled: true,
    name: "Grok 4 (Console)",
    consoleModel: "grok-4",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  {
    id: "grok-4.20",
    modeId: "fast",
    tier: "basic",
    capability: "chat",
    enabled: true,
    name: "Grok 4.20 (Console)",
    consoleModel: "grok-4.20",
    supportedReasoningEfforts: ["none"],
  },
  {
    id: "grok-4.20-reasoning",
    modeId: "fast",
    tier: "basic",
    capability: "chat",
    enabled: true,
    name: "Grok 4.20 Reasoning (Console)",
    consoleModel: "grok-4.20-0309-reasoning",
    supportedReasoningEfforts: ["none"],
  },
  {
    id: "grok-4.20-non-reasoning",
    modeId: "fast",
    tier: "basic",
    capability: "chat",
    enabled: true,
    name: "Grok 4.20 Non-Reasoning (Console)",
    consoleModel: "grok-4.20-0309-non-reasoning",
    supportedReasoningEfforts: ["none"],
  },
  {
    id: "grok-4.20-multi-agent",
    modeId: "fast",
    tier: "basic",
    capability: "chat",
    enabled: true,
    name: "Grok 4.20 Multi-Agent (Console)",
    consoleModel: "grok-4.20-multi-agent-0309",
    supportedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
  {
    id: "grok-build-0.1",
    modeId: "fast",
    tier: "basic",
    capability: "chat",
    enabled: true,
    name: "Grok Build 0.1 (Console)",
    consoleModel: "grok-build-0.1",
    supportedReasoningEfforts: ["none"],
  },

  { id: "grok-imagine-image-lite", modeId: "fast", tier: "basic", capability: "image", enabled: true, name: "Grok Imagine Image Lite" },
  { id: "grok-imagine-image", modeId: "auto", tier: "super", capability: "image", enabled: true, name: "Grok Imagine Image" },
  { id: "grok-imagine-image-pro", modeId: "auto", tier: "super", capability: "image", enabled: true, name: "Grok Imagine Image Pro" },
  { id: "grok-imagine-image-edit", modeId: "auto", tier: "super", capability: "image_edit", enabled: true, name: "Grok Imagine Image Edit" },
  { id: "grok-imagine-video", modeId: "auto", tier: "super", capability: "video", enabled: true, name: "Grok Imagine Video" },
];

const BY_ID = new Map(MODELS.map((m) => [m.id, m]));

export function getModel(id: string): ModelSpec | undefined {
  return BY_ID.get(id);
}

export function poolCandidates(spec: ModelSpec): PoolName[] {
  if (spec.preferBest) {
    if (spec.tier === "heavy") return ["heavy"];
    if (spec.tier === "super") return ["heavy", "super"];
    return ["heavy", "super", "basic"];
  }
  if (spec.tier === "basic") return ["basic", "super", "heavy"];
  if (spec.tier === "super") return ["super", "heavy"];
  return ["heavy"];
}

export function isWorkerSupportedModel(spec: ModelSpec): boolean {
  if (spec.capability === "chat") return true;
  if (spec.id === "grok-imagine-image-lite") return true;
  return false;
}

const CONSOLE_APP_CHAT_FALLBACKS: Record<string, string> = {
  "grok-4.3": "grok-4.3-beta",
  "grok-4": "grok-4.20-auto",
  "grok-4.20": "grok-4.20-auto",
  "grok-4.20-reasoning": "grok-4.20-expert",
  "grok-4.20-non-reasoning": "grok-4.20-fast",
  "grok-4.20-multi-agent": "grok-4.20-multi-agent-0309",
  "grok-build-0.1": "grok-4.20-fast",
};

export function useConsoleUpstream(env: Env): boolean {
  return boolEnv(env, "USE_CONSOLE_UPSTREAM", false);
}

export function appChatModelsEnabled(env: Env): boolean {
  return boolEnv(env, "ENABLE_APP_CHAT_MODELS", true);
}

export function appChatFallbackSpec(spec: ModelSpec): ModelSpec {
  if (!spec.consoleModel) return spec;
  const fallback = getModel(CONSOLE_APP_CHAT_FALLBACKS[spec.id] || "") || spec;
  return {
    ...fallback,
    id: spec.id,
    capability: spec.capability,
    enabled: spec.enabled,
    name: `${spec.name} via grok.com app-chat`,
    consoleModel: undefined,
    defaultReasoningEffort: undefined,
    supportedReasoningEfforts: DEFAULT_CHAT_REASONING_EFFORTS,
  };
}

export function supportedReasoningEfforts(spec: ModelSpec): ReasoningEffort[] {
  const efforts: ReasoningEffort[] = spec.supportedReasoningEfforts?.length
    ? spec.supportedReasoningEfforts
    : spec.capability === "chat"
      ? DEFAULT_CHAT_REASONING_EFFORTS
      : ["none"];
  return [...new Set(efforts.filter((effort): effort is ReasoningEffort => REASONING_EFFORTS.includes(effort)))];
}

export function assertReasoningEffortSupported(spec: ModelSpec, effort: string | null | undefined, param = "reasoning_effort"): void {
  if (!effort || effort === "none") return;
  if (!REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
    throw new ApiError(`reasoning effort must be one of ${JSON.stringify(REASONING_EFFORTS)}`, {
      status: 400,
      type: "invalid_request_error",
      code: "invalid_reasoning_effort",
      param,
    });
  }
  const supported = supportedReasoningEfforts(spec);
  const accepted = supported.includes(effort as ReasoningEffort) || (effort === "xhigh" && supported.includes("high"));
  if (!accepted) {
    throw new ApiError(`Model ${spec.id} does not support reasoning effort ${JSON.stringify(effort)}. Supported: ${supported.join(", ") || "none"}.`, {
      status: 400,
      type: "invalid_request_error",
      code: "unsupported_reasoning_effort",
      param,
    });
  }
}

export function runtimeModelSpec(env: Env, spec: ModelSpec): ModelSpec | null {
  if (spec.consoleModel && useConsoleUpstream(env)) return spec;
  if (!appChatModelsEnabled(env)) return null;
  return spec.consoleModel ? appChatFallbackSpec(spec) : spec;
}

function passesRuntimeStaticChecks(env: Env, spec: ModelSpec, exposeAll = false): boolean {
  if (!spec.enabled) return false;
  if (!exposeAll && !isWorkerSupportedModel(spec)) return false;
  if (spec.consoleModel && !boolEnv(env, "ENABLE_CONSOLE_MODELS", true)) return false;
  return true;
}

export async function isRuntimeAvailableModel(env: Env, spec: ModelSpec): Promise<boolean> {
  if (!passesRuntimeStaticChecks(env, spec)) return false;
  const runtimeSpec = runtimeModelSpec(env, spec);
  return !!runtimeSpec && (await hasAnyTokenForPools(env, poolCandidates(runtimeSpec)));
}

export async function listAvailableModels(env: Env): Promise<ModelSpec[]> {
  const exposeAll = boolEnv(env, "WORKER_EXPOSE_ALL_MODELS", false);
  const out: ModelSpec[] = [];
  for (const m of MODELS) {
    if (!passesRuntimeStaticChecks(env, m, exposeAll)) continue;
    const runtimeSpec = runtimeModelSpec(env, m);
    if (!runtimeSpec) continue;
    if (await hasAnyTokenForPools(env, poolCandidates(runtimeSpec))) out.push(m);
  }
  return out;
}
