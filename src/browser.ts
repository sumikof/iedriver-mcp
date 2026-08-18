import { Builder, By, WebDriver, WebElement, until } from "selenium-webdriver";
import * as ie from "selenium-webdriver/ie.js";
import { config, log } from "./config.js";
import { ErrorCode, ToolError, isDriverLost, toToolError, toolError } from "./errors.js";
import { Selector, Target, describeSelector, toBy } from "./selectors.js";

export type PageInfo = {
  url: string;
  title: string;
};

export type ElementInfo = {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  text?: string;
  value?: string;
  placeholder?: string;
  href?: string;
  disabled?: boolean;
  optionCount?: number;
};

export type PageSnapshot = PageInfo & {
  frame?: Selector;
  text: string;
  elements: ElementInfo[];
  truncated: boolean;
};

export type WaitCondition = {
  type: "present" | "visible" | "enabled" | "text" | "url" | "title";
  selector?: Selector;
  frame?: Selector;
  text?: string;
  timeoutMs?: number;
};

export type WindowTarget = {
  target?: "newest";
  index?: number;
  timeoutMs?: number;
};

export type WindowInfo = PageInfo & {
  index: number;
  windowCount: number;
};

const INSPECT_TAGS = ["a", "button", "input", "textarea", "select", "iframe"] as const;
const MAX_ELEMENTS = 300;
const MAX_TEXT_LENGTH = 4000;
const MAX_ELEMENT_TEXT_LENGTH = 120;
const POLL_INTERVAL_MS = 250;

/**
 * inspect_page 用のページ走査スクリプト。
 * IE Mode ではページが古い Document Mode で動作する場合があるため、
 * ES5 の範囲 (querySelectorAll / Array.prototype.filter などを使わない) で記述する。
 */
const INSPECT_SCRIPT = `
var TAGS = ${JSON.stringify(INSPECT_TAGS)};
var MAX = ${MAX_ELEMENTS};
function norm(value, max) {
  if (!value) return "";
  return String(value).replace(/\\s+/g, " ").replace(/^ /, "").replace(/ $/, "").substring(0, max);
}
function attr(el, name) {
  if (!el.getAttribute) return "";
  var value = el.getAttribute(name);
  return value === null || value === undefined ? "" : String(value);
}
function visible(el) {
  var style = el.currentStyle || (window.getComputedStyle ? window.getComputedStyle(el, null) : null);
  if (style && (style.display === "none" || style.visibility === "hidden")) return false;
  return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
}
var elements = [];
var truncated = false;
for (var t = 0; t < TAGS.length; t++) {
  var nodes = document.getElementsByTagName(TAGS[t]);
  for (var n = 0; n < nodes.length; n++) {
    if (elements.length >= MAX) { truncated = true; break; }
    var el = nodes[n];
    var type = attr(el, "type");
    if (TAGS[t] === "input" && type.toLowerCase() === "hidden") continue;
    if (!visible(el)) continue;
    var item = { tag: TAGS[t] };
    var id = attr(el, "id");
    var name = attr(el, "name");
    var placeholder = attr(el, "placeholder");
    var href = attr(el, "href");
    var text = norm(el.innerText || el.textContent, ${MAX_ELEMENT_TEXT_LENGTH});
    if (TAGS[t] === "select") {
      // <select> の text はすべての option の連結になるため、選択中の option のみを返す。
      var selected = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      text = selected ? norm(selected.text || selected.innerText, ${MAX_ELEMENT_TEXT_LENGTH}) : "";
      item.optionCount = el.options ? el.options.length : 0;
    }
    if (id) item.id = id;
    if (name) item.name = name;
    if (type) item.type = type;
    if (text) item.text = text;
    if (TAGS[t] === "input" || TAGS[t] === "textarea" || TAGS[t] === "select") {
      var value = el.value;
      if (value !== null && value !== undefined && value !== "") {
        item.value = norm(value, ${MAX_ELEMENT_TEXT_LENGTH});
      }
    }
    if (placeholder) item.placeholder = placeholder;
    if (href) item.href = norm(href, 300);
    if (el.disabled) item.disabled = true;
    elements.push(item);
  }
  if (truncated) break;
}
var body = document.body ? (document.body.innerText || document.body.textContent) : "";
return { text: norm(body, ${MAX_TEXT_LENGTH}), elements: elements, truncated: truncated };
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Element 検索や Window Handle 検出など、副作用のない操作のみに使用する最小限の Retry。
 * click / 送信など副作用のある操作には使用しない。
 */
async function retry<T>(fn: () => Promise<T>, count = 2): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < count; i++) {
    try {
      return await fn();
    } catch (error) {
      if (isDriverLost(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * ブラウザセッションは 1 つのみ。すべての WebDriver 操作はこのクラスを経由し、
 * Promise Chain によって完全に逐次実行される。
 */
export class BrowserManager {
  private driver: WebDriver | null = null;
  private queue: Promise<void> = Promise.resolve();
  private knownHandles: string[] = [];

  async start(): Promise<{ status: "ready"; reused: boolean }> {
    return this.serialized(async () => {
      if (this.driver && (await this.isAlive(this.driver))) {
        return { status: "ready" as const, reused: true };
      }
      this.driver = null;

      const options = new ie.Options();
      options.setEdgeChromium(true);
      if (config.edgePath) options.setEdgePath(config.edgePath);
      options.ignoreZoomSetting(true);

      const builder = new Builder().forBrowser("internet explorer").setIeOptions(options);
      if (config.driverPath) builder.setIeService(new ie.ServiceBuilder(config.driverPath));

      try {
        const driver = await builder.build();
        this.driver = driver;
        this.knownHandles = await driver.getAllWindowHandles();
        log({ tool: "browser_start", event: "started", handles: this.knownHandles.length });
        return { status: "ready" as const, reused: false };
      } catch (error) {
        this.driver = null;
        throw toToolError(error, "INTERNAL_ERROR");
      }
    });
  }

  async close(): Promise<{ status: "closed" }> {
    return this.serialized(async () => {
      const driver = this.driver;
      this.driver = null;
      this.knownHandles = [];
      if (driver) {
        try {
          await driver.quit();
        } catch (error) {
          // 何度呼ばれてもエラーにしない。終了時の失敗は stderr に記録するだけ。
          log({ tool: "browser_close", event: "quit_failed", message: String(error).split("\n")[0] });
        }
      }
      return { status: "closed" as const };
    });
  }

  async navigate(url: string): Promise<PageInfo> {
    this.assertAllowedUrl(url);
    return this.exec("NAVIGATION_FAILED", { url }, async (driver) => {
      await driver.get(url);
      this.knownHandles = await driver.getAllWindowHandles();
      return this.pageInfo(driver);
    });
  }

  async inspect(frame?: Selector): Promise<PageSnapshot> {
    return this.exec("INTERNAL_ERROR", frame ? { frame } : {}, async (driver) => {
      await driver.switchTo().defaultContent();
      if (frame) {
        const frameElement = await this.findElement(driver, frame, "frame");
        await driver.switchTo().frame(frameElement);
      }

      const page = await this.pageInfo(driver);
      let snapshot: { text: string; elements: ElementInfo[]; truncated: boolean };
      try {
        snapshot = (await driver.executeScript(INSPECT_SCRIPT)) as typeof snapshot;
      } catch (error) {
        // JavaScript が実行できない画面向けのフォールバック (低速だが確実)。
        log({ tool: "inspect_page", event: "script_failed", message: String(error).split("\n")[0] });
        snapshot = await this.inspectViaDom(driver);
      }

      return {
        ...page,
        ...(frame ? { frame } : {}),
        text: snapshot.text ?? "",
        elements: snapshot.elements ?? [],
        truncated: Boolean(snapshot.truncated),
      };
    });
  }

  async click(target: Target): Promise<PageInfo> {
    return this.exec("INTERNAL_ERROR", { selector: target.selector }, async (driver) => {
      const element = await this.resolveElement(driver, target);
      await driver.wait(until.elementIsVisible(element), config.timeoutMs);
      await driver.wait(until.elementIsEnabled(element), config.timeoutMs);
      // 副作用があるため click 自体は Retry しない。
      await element.click();
      await driver.switchTo().defaultContent();
      return this.pageInfo(driver);
    });
  }

  async type(target: Target, text: string, clear = true): Promise<void> {
    return this.exec("INTERNAL_ERROR", { selector: target.selector }, async (driver) => {
      const element = await this.resolveElement(driver, target);
      await driver.wait(until.elementIsVisible(element), config.timeoutMs);
      await driver.wait(until.elementIsEnabled(element), config.timeoutMs);
      if (clear) await element.clear();
      await element.sendKeys(text);
      await driver.switchTo().defaultContent();
    });
  }

  async select(
    target: Target,
    by: "text" | "value" | "index",
    value: string | number,
  ): Promise<{ text: string; value: string; index: number }> {
    return this.exec("INTERNAL_ERROR", { selector: target.selector }, async (driver) => {
      const element = await this.resolveElement(driver, target);
      const tagName = (await element.getTagName()).toLowerCase();
      if (tagName !== "select") {
        throw toolError("INVALID_ARGUMENT", `Element is <${tagName}>, not <select>.`, {
          selector: target.selector,
        });
      }

      const options = await element.findElements(By.css("option"));
      const index = await this.findOptionIndex(options, by, value);
      const option = options[index];
      if (!option) {
        throw toolError("ELEMENT_NOT_FOUND", "Matching <option> was not found.", {
          selector: target.selector,
          by,
          value,
        });
      }

      await option.click();
      const selected = {
        text: (await option.getText()).trim(),
        value: (await option.getAttribute("value")) ?? "",
        index,
      };
      await driver.switchTo().defaultContent();
      return selected;
    });
  }

  async waitFor(condition: WaitCondition): Promise<{ type: string; waitedMs: number }> {
    const timeoutMs = condition.timeoutMs ?? config.timeoutMs;
    const needsSelector = ["present", "visible", "enabled", "text"].includes(condition.type);
    if (needsSelector && !condition.selector) {
      throw toolError("INVALID_ARGUMENT", `wait_for type "${condition.type}" requires a selector.`);
    }
    if (["text", "url", "title"].includes(condition.type) && !condition.text) {
      throw toolError("INVALID_ARGUMENT", `wait_for type "${condition.type}" requires text.`);
    }

    return this.exec(
      "TIMEOUT",
      { type: condition.type, ...(condition.selector ? { selector: condition.selector } : {}) },
      async (driver) => {
        const started = Date.now();
        const deadline = started + timeoutMs;
        let lastError: unknown;

        for (;;) {
          try {
            if (await this.checkCondition(driver, condition)) {
              return { type: condition.type, waitedMs: Date.now() - started };
            }
          } catch (error) {
            if (isDriverLost(error)) throw error;
            lastError = error;
          }
          if (Date.now() >= deadline) break;
          await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
        }

        throw toolError("TIMEOUT", `Condition "${condition.type}" was not met within ${timeoutMs}ms.`, {
          ...(condition.selector ? { selector: condition.selector } : {}),
          ...(condition.text ? { text: condition.text } : {}),
          ...(lastError ? { lastError: String(lastError).split("\n")[0] } : {}),
        });
      },
    );
  }

  async switchWindow(target: WindowTarget): Promise<WindowInfo> {
    if (target.target !== "newest" && target.index === undefined) {
      throw toolError("INVALID_ARGUMENT", 'switch_window requires either target:"newest" or index.');
    }

    return this.exec("WINDOW_NOT_FOUND", { ...target }, async (driver) => {
      const timeoutMs = target.timeoutMs ?? config.timeoutMs;
      let handles = await driver.getAllWindowHandles();
      let handle: string | undefined;

      if (target.target === "newest") {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const fresh = handles.filter((value) => !this.knownHandles.includes(value));
          handle = fresh.at(-1) ?? undefined;
          if (handle || Date.now() >= deadline) break;
          await sleep(POLL_INTERVAL_MS);
          handles = await retry(() => driver.getAllWindowHandles());
        }
        // 新規 Window が検出できなかった場合は、現在存在する最後の Window を使用する。
        handle ??= handles.at(-1);
      } else {
        handle = handles[target.index as number];
      }

      if (!handle) {
        throw toolError("WINDOW_NOT_FOUND", "Window was not found.", {
          ...target,
          windowCount: handles.length,
        });
      }

      await driver.switchTo().window(handle);
      await driver.switchTo().defaultContent();
      this.knownHandles = handles;
      const page = await this.pageInfo(driver);
      return { ...page, index: handles.indexOf(handle), windowCount: handles.length };
    });
  }

  async screenshot(): Promise<string> {
    return this.exec("INTERNAL_ERROR", {}, async (driver) => driver.takeScreenshot());
  }

  // ------------------------------------------------------------------
  // 内部処理
  // ------------------------------------------------------------------

  /** IEDriver へは常に 1 件ずつしか操作を送らない。 */
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 逐次実行 + driver 存在確認 + Error 変換をまとめて行う。 */
  private exec<T>(
    fallback: ErrorCode,
    details: Record<string, unknown>,
    fn: (driver: WebDriver) => Promise<T>,
  ): Promise<T> {
    return this.serialized(async () => {
      const driver = this.driver;
      if (!driver) {
        throw toolError("BROWSER_NOT_STARTED", "Browser is not started. Run browser_start first.");
      }
      try {
        return await fn(driver);
      } catch (error) {
        const converted: ToolError = toToolError(error, fallback, details);
        if (converted.code === "DRIVER_LOST") {
          // 自動復旧は行わない。browser_start による明示的な再起動で復旧する。
          this.driver = null;
          this.knownHandles = [];
        }
        throw converted;
      }
    });
  }

  private async isAlive(driver: WebDriver): Promise<boolean> {
    try {
      await driver.getCurrentUrl();
      return true;
    } catch {
      return false;
    }
  }

  private async pageInfo(driver: WebDriver): Promise<PageInfo> {
    return { url: await driver.getCurrentUrl(), title: await driver.getTitle() };
  }

  private assertAllowedUrl(url: string): void {
    if (config.allowedOrigins.includes("*")) return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      throw toolError("INVALID_ARGUMENT", `Invalid URL: ${url}`, { url });
    }
    if (!config.allowedOrigins.includes(origin)) {
      throw toolError("URL_NOT_ALLOWED", `Origin ${origin} is not allowed.`, {
        url,
        allowedOrigins: config.allowedOrigins,
      });
    }
  }

  /** defaultContent へ戻し、frame 指定があれば切り替えてから Element を検索する。 */
  private async resolveElement(driver: WebDriver, target: Target): Promise<WebElement> {
    await driver.switchTo().defaultContent();
    if (target.frame) {
      const frameElement = await this.findElement(driver, target.frame, "frame");
      await driver.switchTo().frame(frameElement);
    }
    return this.findElement(driver, target.selector, "element");
  }

  private async findElement(
    driver: WebDriver,
    selector: Selector,
    kind: "element" | "frame",
  ): Promise<WebElement> {
    // 検索は副作用がないため Retry してよい。合計の待ち時間が timeoutMs を大きく超えないよう、
    // 1 回あたりの待機時間を分割する。
    const attemptTimeoutMs = Math.max(1000, Math.floor(config.timeoutMs / 2));
    try {
      return await retry(() => driver.wait(until.elementLocated(toBy(selector)), attemptTimeoutMs));
    } catch (error) {
      if (isDriverLost(error)) throw error;
      throw toolError(
        "ELEMENT_NOT_FOUND",
        `${kind === "frame" ? "Frame" : "Element"} was not found: ${describeSelector(selector)}`,
        { selector },
      );
    }
  }

  private async findOptionIndex(
    options: WebElement[],
    by: "text" | "value" | "index",
    value: string | number,
  ): Promise<number> {
    if (by === "index") {
      const index = Number(value);
      if (!Number.isInteger(index) || index < 0) {
        throw toolError("INVALID_ARGUMENT", `Invalid option index: ${String(value)}`);
      }
      return index;
    }

    const expected = String(value).trim();
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!;
      const actual =
        by === "value" ? ((await option.getAttribute("value")) ?? "") : await option.getText();
      if (actual.trim() === expected) return i;
    }
    return -1;
  }

  private async checkCondition(driver: WebDriver, condition: WaitCondition): Promise<boolean> {
    switch (condition.type) {
      case "url":
        return (await driver.getCurrentUrl()).includes(condition.text!);
      case "title":
        return (await driver.getTitle()).includes(condition.text!);
      default:
        break;
    }

    const target: Target = {
      selector: condition.selector!,
      ...(condition.frame ? { frame: condition.frame } : {}),
    };
    await driver.switchTo().defaultContent();
    if (target.frame) {
      const frames = await driver.findElements(toBy(target.frame));
      const frame = frames[0];
      if (!frame) return false;
      await driver.switchTo().frame(frame);
    }
    const elements = await driver.findElements(toBy(target.selector));
    const element = elements[0];
    if (!element) return false;

    switch (condition.type) {
      case "present":
        return true;
      case "visible":
        return element.isDisplayed();
      case "enabled":
        return (await element.isDisplayed()) && (await element.isEnabled());
      case "text":
        return (await element.getText()).includes(condition.text!);
      default:
        return false;
    }
  }

  /** executeScript が使用できない場合の inspect フォールバック。 */
  private async inspectViaDom(
    driver: WebDriver,
  ): Promise<{ text: string; elements: ElementInfo[]; truncated: boolean }> {
    const elements: ElementInfo[] = [];
    let truncated = false;

    for (const tag of INSPECT_TAGS) {
      const found = await driver.findElements(By.css(tag));
      for (const element of found) {
        if (elements.length >= MAX_ELEMENTS) {
          truncated = true;
          break;
        }
        const type = (await element.getAttribute("type")) ?? "";
        if (tag === "input" && type.toLowerCase() === "hidden") continue;
        if (!(await element.isDisplayed())) continue;

        const info: ElementInfo = { tag };
        const id = (await element.getAttribute("id")) ?? "";
        const name = (await element.getAttribute("name")) ?? "";
        const text = (await element.getText()).replace(/\s+/g, " ").trim();
        if (id) info.id = id;
        if (name) info.name = name;
        if (type) info.type = type;
        if (text) info.text = text.slice(0, MAX_ELEMENT_TEXT_LENGTH);
        if (!(await element.isEnabled())) info.disabled = true;
        elements.push(info);
      }
      if (truncated) break;
    }

    let text = "";
    try {
      const body = await driver.findElement(By.css("body"));
      text = (await body.getText()).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
    } catch {
      text = "";
    }

    return { text, elements, truncated };
  }
}

export const browser = new BrowserManager();
