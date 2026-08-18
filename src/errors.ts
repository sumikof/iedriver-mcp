/**
 * Selenium の Error を MCP 用の最小限の Error Code へ変換する。
 * Selenium の長い Stack Trace はそのまま LLM へ返さない。
 */

export type ErrorCode =
  | "BROWSER_NOT_STARTED"
  | "ELEMENT_NOT_FOUND"
  | "TIMEOUT"
  | "WINDOW_NOT_FOUND"
  | "NAVIGATION_FAILED"
  | "DRIVER_LOST"
  | "URL_NOT_ALLOWED"
  | "INVALID_ARGUMENT"
  | "INTERNAL_ERROR";

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
  }

  toJSON(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.details };
  }
}

export function toolError(
  code: ErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): ToolError {
  return new ToolError(code, message, details);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** WebDriver session が失われた (IEDriver / Edge の異常終了など) かどうか。 */
export function isDriverLost(error: unknown): boolean {
  if (error instanceof ToolError) return error.code === "DRIVER_LOST";
  const name = errorName(error);
  if (
    name === "NoSuchSessionError" ||
    name === "SessionNotCreatedError" ||
    name === "InvalidSessionIdError"
  ) {
    return true;
  }
  const message = errorMessage(error);
  return (
    /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i.test(message) ||
    /session (is )?(deleted|not (created|started)|id is null)/i.test(message) ||
    /Session ID is null/i.test(message)
  );
}

/**
 * 任意の Error を ToolError へ変換する。
 * fallback は分類できなかった場合に使用する Error Code。
 */
export function toToolError(
  error: unknown,
  fallback: ErrorCode = "INTERNAL_ERROR",
  details: Record<string, unknown> = {},
): ToolError {
  if (error instanceof ToolError) {
    return new ToolError(error.code, error.message, { ...details, ...error.details });
  }

  if (isDriverLost(error)) {
    return toolError(
      "DRIVER_LOST",
      "WebDriver session is no longer available. Run browser_start again.",
      details,
    );
  }

  const name = errorName(error);
  const message = errorMessage(error).split("\n")[0]?.trim() ?? "Unknown error";

  switch (name) {
    case "NoSuchElementError":
    case "StaleElementReferenceError":
      return toolError("ELEMENT_NOT_FOUND", "Element was not found.", details);
    case "NoSuchFrameError":
      return toolError("ELEMENT_NOT_FOUND", "Frame was not found.", details);
    case "TimeoutError":
    case "ScriptTimeoutError":
      return toolError("TIMEOUT", "Operation timed out.", details);
    case "NoSuchWindowError":
      return toolError("WINDOW_NOT_FOUND", "Window was not found.", details);
    case "InvalidArgumentError":
    case "InvalidSelectorError":
      return toolError("INVALID_ARGUMENT", message, details);
    default:
      return toolError(fallback, message, details);
  }
}
