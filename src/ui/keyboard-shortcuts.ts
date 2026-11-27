import { navigationItems } from "../../js/routes.js";
import { blocksShortcut } from "./keyboard-input";

// One owner for the app shell's single-key shortcuts: 'g' sequences, '/',
// '?' and the j/k card traversal. The ⌘/Ctrl+K search key stays in the
// app shell's capture listener; it is listed here only so the help dialog
// shows every shortcut.
const SEQUENCE_MS = 1000;
const GO_TO = { h: "Home", d: "Deals", l: "Leads", c: "Calendar", v: "Vendors" } as const;

const destinations = Object.entries(GO_TO).map(([key, label]) => {
  const item = navigationItems.find((page) => page.label === label);
  if (!item) throw new Error(`Missing navigation item ${label}`);
  return { key, label, href: item.href };
});

type Shortcut = { keys: string[]; sequence?: boolean; or?: boolean; description: string };

const shortcuts: Shortcut[] = [
  ...destinations.map(({ key, label }) => ({ keys: ["g", key], sequence: true, description: `Go to ${label}` })),
  { keys: ["/"], description: "Search this page, or open the quick switcher" },
  { keys: ["?"], description: "Show keyboard shortcuts" },
  { keys: ["⌘/Ctrl", "K"], description: "Open search" },
  { keys: ["j", "↓"], or: true, description: "Next card (Home, Deals)" },
  { keys: ["k", "↑"], or: true, description: "Previous card (Home, Deals)" },
  // Enter is the focused open control's own activation: listed, not handled.
  { keys: ["Enter"], description: "Open the selected card" },
];

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock"]);

const visible = (element: HTMLElement): boolean =>
  element.getClientRects().length > 0 && !(element instanceof HTMLInputElement && element.disabled);

// Pages mark a card with [data-shortcut-card] and its open control with
// [data-shortcut-open]. A card counts only while its open control is shown.
const CARD = "[data-shortcut-card]";
const CARD_STEP = new Map<string, 1 | -1>([
  ["j", 1],
  ["ArrowDown", 1],
  ["k", -1],
  ["ArrowUp", -1],
]);
const ARROWS = new Set(["ArrowDown", "ArrowUp"]);
const shown = (element: HTMLElement): boolean =>
  element.getClientRects().length > 0 && !element.closest("details:not([open])");

function cardControls(root: Document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(CARD)).flatMap((card) => {
    const control = Array.from(card.querySelectorAll<HTMLElement>("[data-shortcut-open]")).find(
      (node) => node.closest(CARD) === card,
    );
    return control && shown(control) ? [control] : [];
  });
}

// Moves focus to the next or previous card's open control, without wrapping.
// With no current card it starts at the first. Returns whether focus moved.
function stepCard(root: Document, step: 1 | -1): boolean {
  const controls = cardControls(root);
  const current = root.activeElement?.closest(CARD);
  const index = current ? controls.findIndex((control) => control.closest(CARD) === current) : -1;
  const target = index < 0 ? controls[0] : controls[index + step];
  if (!target || target === root.activeElement) return false;
  target.focus();
  return root.activeElement === target;
}

// Arrows scroll drawers and menus and belong to an open item or a lifted
// board card, so they step cards only from the page body or from a card's own
// open control. j and k are letters and keep working wherever focus is.
function arrowsStepCards(root: Document): boolean {
  const active = root.activeElement;
  if (!active || active === root.body) return true;
  const onCard = active.matches(CARD) || (active.matches("[data-shortcut-open]") && active.closest(CARD) !== null);
  return onCard && active.closest("[data-lifted]") === null;
}

function renderHelp(root: Document): HTMLDialogElement {
  const dialog = root.createElement("dialog");
  dialog.className = "keyboard-shortcuts";
  dialog.setAttribute("aria-labelledby", "keyboardShortcutsTitle");
  const header = root.createElement("header");
  const title = root.createElement("h2");
  title.id = "keyboardShortcutsTitle";
  title.textContent = "Keyboard shortcuts";
  const close = root.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.setAttribute("aria-label", "Close keyboard shortcuts");
  close.addEventListener("click", () => dialog.close());
  header.append(title, close);
  const table = root.createElement("table");
  const body = root.createElement("tbody");
  for (const shortcut of shortcuts) {
    const row = root.createElement("tr");
    const keys = root.createElement("td");
    shortcut.keys.forEach((key, index) => {
      if (index > 0) keys.append(shortcut.sequence ? " then " : shortcut.or ? " or " : " + ");
      const kbd = root.createElement("kbd");
      kbd.textContent = key;
      keys.append(kbd);
    });
    const description = root.createElement("td");
    description.textContent = shortcut.description;
    row.append(keys, description);
    body.append(row);
  }
  table.append(body);
  dialog.append(header, table);
  return dialog;
}

export function mountKeyboardShortcuts({ root, openSearch }: { root: Document; openSearch: () => unknown }): {
  dispose(): void;
} {
  const win = root.defaultView;
  if (!win) return { dispose() {} };
  // A pending 'g' is the time it was pressed; the next key reads it against
  // SEQUENCE_MS, so no timer outlives the sequence or the session.
  let pendingG: number | null = null;
  let help: HTMLDialogElement | null = null;
  let disposed = false;

  const showHelp = () => {
    if (help) return;
    const active = root.activeElement;
    const opener = active instanceof HTMLElement && active !== root.body ? active : null;
    const dialog = renderHelp(root);
    dialog.addEventListener("close", () => {
      dialog.remove();
      if (help !== dialog) return;
      help = null;
      const target = opener?.isConnected ? opener : root.querySelector<HTMLElement>(".quick-switcher-toggle");
      target?.focus();
    });
    help = dialog;
    root.body.append(dialog);
    dialog.showModal();
  };

  const slash = () => {
    const field = Array.from(root.querySelectorAll<HTMLElement>("[data-slash-search]")).find(visible);
    if (field) field.focus();
    else void openSearch();
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (disposed || event.defaultPrevented || MODIFIER_KEYS.has(event.key)) return;
    if (blocksShortcut(event) || root.querySelector("dialog:modal")) {
      pendingG = null;
      return;
    }
    if (event.repeat) return;
    if (pendingG !== null) {
      const live = event.timeStamp - pendingG < SEQUENCE_MS;
      pendingG = null;
      const destination = live && destinations.find(({ key }) => key === event.key);
      if (destination) {
        event.preventDefault();
        win.location.assign(destination.href);
        return;
      }
    }
    if (event.key === "g") pendingG = event.timeStamp;
    else if (event.key === "/") {
      event.preventDefault();
      slash();
    } else if (event.key === "?") {
      event.preventDefault();
      showHelp();
    } else {
      const step = CARD_STEP.get(event.key);
      if (!step || (ARROWS.has(event.key) && !arrowsStepCards(root))) return;
      if (stepCard(root, step)) event.preventDefault();
    }
  };

  win.addEventListener("keydown", onKeydown);
  return {
    dispose() {
      disposed = true;
      pendingG = null;
      win.removeEventListener("keydown", onKeydown);
      const dialog = help;
      help = null;
      dialog?.remove();
    },
  };
}
