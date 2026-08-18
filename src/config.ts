/**
 * 設定は環境変数のみで行う。設定ファイル (YAML / JSON) は使用しない。
 *
 *   IE_MCP_EDGE_PATH        msedge.exe のパス (省略時は IEDriver の既定動作に任せる)
 *   IE_MCP_DRIVER_PATH      IEDriverServer.exe のパス (省略時は PATH から探索)
 *   IE_MCP_ALLOWED_ORIGINS  navigate を許可する Origin のカンマ区切り ("*" で無制限)
 *   IE_MCP_TIMEOUT_MS       既定のタイムアウト (ms)
 */

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return ["*"];
  const origins = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return origins.length > 0 ? origins : ["*"];
}

function parseTimeout(raw: string | undefined): number {
  const value = Number(raw ?? "10000");
  return Number.isFinite(value) && value > 0 ? value : 10000;
}

export const config = {
  edgePath: process.env.IE_MCP_EDGE_PATH,
  driverPath: process.env.IE_MCP_DRIVER_PATH,
  allowedOrigins: parseOrigins(process.env.IE_MCP_ALLOWED_ORIGINS),
  timeoutMs: parseTimeout(process.env.IE_MCP_TIMEOUT_MS),
} as const;

/**
 * stdout は MCP Protocol が使用するため、ログは必ず stderr に JSON で出力する。
 * Logging Framework は使用しない。
 */
export function log(entry: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "info", ...entry }));
}
