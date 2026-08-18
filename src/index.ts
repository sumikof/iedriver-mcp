#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { browser } from "./browser.js";
import { log } from "./config.js";
import { registerTools } from "./tools.js";

const server = new McpServer(
  { name: "ie-mode-mcp", version: "0.1.0" },
  {
    instructions:
      "Operates Microsoft Edge in IE Mode for legacy web applications. " +
      "Start with browser_start, then use the loop: inspect_page -> click/type/select -> wait_for -> inspect_page. " +
      "There is a single browser session and all operations run sequentially. " +
      "On a DRIVER_LOST error the session is gone: call browser_start again and do not blindly repeat the last action, " +
      "because it may already have taken effect.",
  },
);

registerTools(server);

let shuttingDown = false;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ event: "shutdown", reason });
  await browser.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const transport = new StdioServerTransport();
await server.connect(transport);
log({ event: "started", transport: "stdio" });
