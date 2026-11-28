import axe from "axe-core";
import type { Page } from "playwright";

export type SurfaceElement = {
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  placeholder?: string;
  pressed?: string;
  expanded?: string;
  hidden?: true;
  quiet?: true;
};

export function installSurfaceCapture(page: Page) {
  return page.addInitScript({ content: axe.source });
}

export function captureSurface(page: Page) {
  return page.evaluate(() => {
    function property(object: unknown, key: string): unknown {
      return typeof object === "object" && object !== null ? Reflect.get(object, key) : undefined;
    }
    function method(object: unknown, key: string) {
      const fn = property(object, key);
      if (typeof fn !== "function") throw new Error(`Axe ${key} is unavailable`);
      return (...args: unknown[]): unknown => Reflect.apply(fn, object, args);
    }
    const browserAxe = property(window, "axe");
    const commons = property(browserAxe, "commons");
    const aria = property(commons, "aria");
    const getRole = method(aria, "getRole");
    const namedFromContents = method(aria, "namedFromContents");
    const accessibleText = method(property(commons, "text"), "accessibleText");
    const setup = method(browserAxe, "setup");
    const teardown = method(browserAxe, "teardown");
    const compact = (value: string) => value.replace(/\s+/g, " ").trim();
    const groupRoles = new Set(["group", "region", "status"]);
    const elements: SurfaceElement[] = [];
    const walk = (element: Element) => {
      const style = getComputedStyle(element);
      const clipped = style.clip === "rect(0px, 0px, 0px, 0px)" || style.clipPath === "inset(50%)";
      const visible =
        !clipped &&
        (element.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || style.display === "contents");
      const role: unknown = getRole(element);
      const described = element.hasAttribute("aria-describedby");
      const group = described || (typeof role === "string" && groupRoles.has(role));
      const node: SurfaceElement = {};
      if (typeof role === "string" && role !== "presentation" && role !== "none") node.role = role;
      else if (described) node.role = "generic";
      if (
        node.role &&
        (namedFromContents(element, { strict: true }) ||
          element.matches("[aria-label],[aria-labelledby],input,select,textarea,img,fieldset,table"))
      ) {
        const label = element.getAttribute("aria-label");
        const references = element
          .getAttribute("aria-labelledby")
          ?.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ");
        const name = visible ? accessibleText(element) : references || label;
        if (typeof name === "string" && compact(name)) node.name = compact(name);
      }
      if (!visible) {
        if (group) elements.push({ ...node, hidden: true });
        return;
      }
      const text = compact(
        [...element.childNodes]
          .filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => child.textContent)
          .join(""),
      );
      if (text) node.text = text;
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement
      )
        node.value = element.value;
      if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.placeholder)
        node.placeholder = element.placeholder;
      const pressed = element.getAttribute("aria-pressed");
      if (pressed !== null) node.pressed = pressed;
      const expanded = element.getAttribute("aria-expanded");
      if (expanded !== null) node.expanded = expanded;
      else if (element instanceof HTMLDetailsElement) node.expanded = String(element.open);
      if (element.classList.contains("quiet")) node.quiet = true;
      // An anonymous wrapper with no recorded properties adds no information to the comparison.
      if (Object.keys(node).length) {
        if (element.getAttribute("aria-hidden") === "true") node.hidden = true;
        elements.push(node);
      }
      for (const child of element.children) walk(child);
    };
    setup();
    try {
      for (const root of document.querySelectorAll("#appTabsSlot, main.business-shell")) walk(root);
      return { href: location.href, elements };
    } finally {
      teardown();
    }
  });
}
