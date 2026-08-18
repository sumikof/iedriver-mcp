import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { browser } from "./browser.js";
import { log } from "./config.js";
import { toToolError } from "./errors.js";
import type { Selector, Target } from "./selectors.js";

const selectorSchema = z.object({
  by: z
    .enum(["id", "name", "css", "xpath", "linkText"])
    .describe("Selector strategy. name and xpath are often required by legacy IE applications."),
  value: z.string().min(1).describe("Selector value."),
});

const frameSchema = selectorSchema
  .optional()
  .describe("Optional iframe/frame to switch into first. One level of nesting is supported.");

const targetShape = {
  selector: selectorSchema,
  frame: frameSchema,
};

function toTarget(args: { selector: z.infer<typeof selectorSchema>; frame?: Selector }): Target {
  return { selector: args.selector, ...(args.frame ? { frame: args.frame } : {}) };
}

function jsonResult(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Tool 実行を共通化する。
 * - stderr へ JSON ログを出力する (stdout は MCP Protocol が使用する)
 * - Error は MCP 用の Error Code へ変換して返す (Selenium の Stack Trace は返さない)
 */
async function runTool(
  name: string,
  logFields: Record<string, unknown>,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const result = await fn();
    log({ tool: name, ...logFields, durationMs: Date.now() - started });
    return result;
  } catch (error) {
    const converted = toToolError(error);
    log({
      level: "error",
      tool: name,
      ...logFields,
      error: converted.code,
      message: converted.message,
      durationMs: Date.now() - started,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(converted.toJSON(), null, 2) }],
      isError: true,
    };
  }
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "browser_start",
    {
      title: "Start Edge IE Mode",
      description:
        "Start Microsoft Edge in IE Mode through IEDriverServer. " +
        "Only one browser session exists; calling this while a session is running returns the existing one. " +
        "Also use this to recover after a DRIVER_LOST error.",
      inputSchema: {},
    },
    async () => runTool("browser_start", {}, async () => jsonResult(await browser.start())),
  );

  server.registerTool(
    "browser_close",
    {
      title: "Close browser",
      description: "Close the browser session. Safe to call repeatedly.",
      inputSchema: {},
    },
    async () => runTool("browser_close", {}, async () => jsonResult(await browser.close())),
  );

  server.registerTool(
    "navigate",
    {
      title: "Navigate",
      description:
        "Navigate the browser to a URL. The origin must be permitted by IE_MCP_ALLOWED_ORIGINS.",
      inputSchema: {
        url: z.string().min(1).describe("Absolute URL to open."),
      },
    },
    async ({ url }) =>
      runTool("navigate", { url }, async () => jsonResult(await browser.navigate(url))),
  );

  server.registerTool(
    "inspect_page",
    {
      title: "Inspect page",
      description:
        "Return the current URL, title, visible page text and the operable elements " +
        "(a, button, input, textarea, select, iframe). The full HTML is never returned. " +
        "Pass frame to inspect the contents of an iframe listed by a previous inspect_page call.",
      inputSchema: {
        frame: frameSchema,
      },
    },
    async ({ frame }) =>
      runTool("inspect_page", frame ? { frame } : {}, async () => {
        const snapshot = await browser.inspect(frame);
        return jsonResult(snapshot);
      }),
  );

  server.registerTool(
    "click",
    {
      title: "Click element",
      description:
        "Click an element after waiting for it to be visible and enabled. " +
        "This operation is never retried automatically, because a repeated click may submit or register data twice.",
      inputSchema: targetShape,
    },
    async (args) =>
      runTool("click", { selector: args.selector }, async () =>
        jsonResult(await browser.click(toTarget(args))),
      ),
  );

  server.registerTool(
    "type",
    {
      title: "Type text",
      description: "Type text into an input or textarea. Set clear to false to append instead of replacing.",
      inputSchema: {
        ...targetShape,
        text: z.string().describe("Text to send to the element."),
        clear: z.boolean().optional().describe("Clear the field first. Default true."),
      },
    },
    async (args) =>
      // 入力値そのものはログに記録しない (パスワード等の秘密情報が含まれうるため)。
      runTool("type", { selector: args.selector, textLength: args.text.length }, async () => {
        await browser.type(toTarget(args), args.text, args.clear ?? true);
        return jsonResult({ status: "ok" });
      }),
  );

  server.registerTool(
    "select",
    {
      title: "Select option",
      description: "Choose an option of an HTML <select> element by visible text, value or index.",
      inputSchema: {
        ...targetShape,
        by: z.enum(["text", "value", "index"]).describe("How to identify the option."),
        value: z.union([z.string(), z.number()]).describe("Option text, value, or zero-based index."),
      },
    },
    async (args) =>
      runTool("select", { selector: args.selector, by: args.by }, async () =>
        jsonResult(await browser.select(toTarget(args), args.by, args.value)),
      ),
  );

  server.registerTool(
    "wait_for",
    {
      title: "Wait for condition",
      description:
        "Wait until a condition holds. present/visible/enabled/text require a selector; " +
        "text/url/title require text, which is matched as a substring. " +
        "Use this instead of sleeping after an action.",
      inputSchema: {
        type: z
          .enum(["present", "visible", "enabled", "text", "url", "title"])
          .describe("Condition to wait for."),
        selector: selectorSchema.optional(),
        frame: frameSchema,
        text: z.string().optional().describe("Expected substring for text/url/title conditions."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in milliseconds. Defaults to IE_MCP_TIMEOUT_MS."),
      },
    },
    async (args) =>
      runTool("wait_for", { type: args.type }, async () => jsonResult(await browser.waitFor(args))),
  );

  server.registerTool(
    "switch_window",
    {
      title: "Switch window",
      description:
        'Switch to another browser window or popup. Use target:"newest" after an action that opens a window, ' +
        "or index to select a window by its zero-based position.",
      inputSchema: {
        target: z.literal("newest").optional().describe('Switch to the newest window.'),
        index: z.number().int().min(0).optional().describe("Zero-based window index."),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("How long to poll for a new window. Defaults to IE_MCP_TIMEOUT_MS."),
      },
    },
    async (args) =>
      runTool("switch_window", { target: args.target, index: args.index }, async () =>
        jsonResult(await browser.switchWindow(args)),
      ),
  );

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description: "Capture the current browser window as a PNG image.",
      inputSchema: {},
    },
    async () =>
      runTool("screenshot", {}, async () => {
        const data = await browser.screenshot();
        return { content: [{ type: "image", data, mimeType: "image/png" }] };
      }),
  );
}
