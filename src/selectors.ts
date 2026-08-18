import { By } from "selenium-webdriver";
import { toolError } from "./errors.js";

/** すべての Element 操作で共通に使用する Selector。 */
export type Selector = {
  by: "id" | "name" | "css" | "xpath" | "linkText";
  value: string;
};

/** 操作対象。frame は 1 階層のみ対応する。 */
export type Target = {
  selector: Selector;
  frame?: Selector;
};

export function toBy(selector: Selector): By {
  switch (selector.by) {
    case "id":
      return By.id(selector.value);
    case "name":
      return By.name(selector.value);
    case "css":
      return By.css(selector.value);
    case "xpath":
      return By.xpath(selector.value);
    case "linkText":
      return By.linkText(selector.value);
    default:
      throw toolError("INVALID_ARGUMENT", `Unsupported selector: ${String(selector.by)}`, {
        selector,
      });
  }
}

export function describeSelector(selector: Selector): string {
  return `${selector.by}=${selector.value}`;
}
