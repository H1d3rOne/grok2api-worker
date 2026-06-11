export interface Env {
  EGRESS?: Fetcher;
  TOKEN_STORE?: KVNamespace;

  API_KEY?: string;
  GROK_TOKENS?: string;
  GROK_SSO_TOKENS?: string;
  GROK_BASIC_TOKENS?: string;
  GROK_SUPER_TOKENS?: string;
  GROK_HEAVY_TOKENS?: string;
  ACCOUNT_POOL_JSON?: string;

  CF_COOKIES?: string;
  CF_CLEARANCE?: string;
  USER_AGENT?: string;
  BROWSER?: string;

  APP_URL?: string;
  STREAM?: string;
  THINKING?: string;
  TEMPORARY?: string;
  MEMORY?: string;
  DYNAMIC_STATSIG?: string;
  SHOW_SEARCH_SOURCES?: string;
  CUSTOM_INSTRUCTION?: string;
  IMAGE_FORMAT?: string;

  MAX_RETRIES?: string;
  RETRY_ON_CODES?: string;
  CHAT_TIMEOUT_SECONDS?: string;
  ASSET_UPLOAD_TIMEOUT_SECONDS?: string;
  ASSET_DOWNLOAD_TIMEOUT_SECONDS?: string;

  CONSOLE_WEB_SEARCH?: string;
  ENABLE_CONSOLE_MODELS?: string;
  USE_CONSOLE_UPSTREAM?: string;
  ENABLE_APP_CHAT_MODELS?: string;
  USE_VPC_EGRESS?: string;
  WORKER_EXPOSE_ALL_MODELS?: string;

  ENABLE_CORS?: string;
  ALLOWED_ORIGINS?: string;
}

export type Role = "system" | "developer" | "user" | "assistant" | "tool" | string;

export interface ChatMessage {
  role: Role;
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<Record<string, unknown>> | null;
  tool_call_id?: string | null;
  name?: string | null;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean | null;
  reasoning_effort?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  max_tokens?: number | null;
  tools?: Array<Record<string, unknown>> | null;
  tool_choice?: string | Record<string, unknown> | null;
  parallel_tool_calls?: boolean | null;
  image_config?: {
    n?: number | null;
    size?: string | null;
    response_format?: string | null;
  } | null;
}

export interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n?: number | null;
  size?: string | null;
  response_format?: "url" | "b64_json" | string | null;
}

export interface ResponsesCreateRequest {
  model: string;
  input: string | unknown[];
  instructions?: string | null;
  stream?: boolean | null;
  reasoning?: Record<string, unknown> | null;
  temperature?: number | null;
  top_p?: number | null;
  max_output_tokens?: number | null;
  tools?: unknown[] | null;
  tool_choice?: unknown;
  previous_response_id?: string | null;
  store?: boolean | null;
  metadata?: Record<string, unknown> | null;
  truncation?: string | null;
  parallel_tool_calls?: boolean | null;
  include?: string[] | null;
  background?: boolean | null;
}

export interface AnthropicMessage {
  role: "user" | "assistant" | string;
  content: string | Array<Record<string, unknown>> | null;
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Array<Record<string, unknown>> | null;
  max_tokens?: number | null;
  stream?: boolean | null;
  temperature?: number | null;
  top_p?: number | null;
  tools?: Array<Record<string, unknown>> | null;
  tool_choice?: string | Record<string, unknown> | null;
  thinking?: Record<string, unknown> | null;
}
