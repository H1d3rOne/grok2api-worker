export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "rate_limit_error"
  | "upstream_error"
  | "not_supported_error"
  | "server_error";

export class ApiError extends Error {
  readonly status: number;
  readonly type: ErrorType;
  readonly code?: string | null;
  readonly param?: string | null;
  readonly body?: string;

  constructor(
    message: string,
    options: {
      status?: number;
      type?: ErrorType;
      code?: string | null;
      param?: string | null;
      body?: string;
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? 500;
    this.type = options.type ?? "server_error";
    this.code = options.code;
    this.param = options.param;
    this.body = options.body;
  }

  toJSON(): Record<string, unknown> {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code ?? null,
        param: this.param ?? null,
      },
    };
  }
}

export class UpstreamError extends ApiError {
  constructor(message: string, status = 502, body = "") {
    super(message, { status, type: "upstream_error", body });
    this.name = "UpstreamError";
  }
}

export function errorResponse(error: unknown, extraHeaders: HeadersInit = {}): Response {
  const apiError = normalizeError(error);
  return jsonResponse(apiError.toJSON(), apiError.status, extraHeaders);
}

export function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    return new ApiError(error.message || "Internal server error", {
      status: 500,
      type: "server_error",
    });
  }
  return new ApiError(String(error || "Internal server error"), {
    status: 500,
    type: "server_error",
  });
}

export function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function notSupported(message: string): ApiError {
  return new ApiError(message, { status: 501, type: "not_supported_error" });
}
