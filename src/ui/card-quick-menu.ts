// A small menu of a card's own controls, opened by right-click, the keyboard
// context-menu key or a touch long-press. Each item clicks the control it names,
// so choosing an item does exactly what clicking that control does.

type QuickAction = { label: string; control: HTMLElement };
type QuickMenuOptions = {
  /** Selector for a card inside the root. */
  card: string;
  /** The card's controls in menu order. Missing, hidden or disabled controls are left out. */
  actions: (card: HTMLElement) => QuickAction[];
  /** Where Escape returns focus. Defaults to the card. */
  focusTarget?: (card: HTMLElement) => HTMLElement | null;
  /** The card's name for the menu label. Defaults to the card's own label. */
  name?: (card: HTMLElement) => string;
};
type OpenMenu = { root: HTMLElement; card: HTMLElement; menu: HTMLElement; focusTarget: () => HTMLElement };

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
const EDGE_PX = 8;
const NATIVE_TARGETS = 'input,textarea,select,[contenteditable]:not([contenteditable="false"]),a[href]';

// Only one menu exists on the page, whichever root opened it.
let current: OpenMenu | null = null;

function closeMenu(restoreFocus = false) {
  const open = current;
  if (!open) return;
  current = null;
  open.menu.remove();
  delete open.root.dataset.quickMenuOpen;
  if (restoreFocus) open.focusTarget().focus({ preventScroll: true });
  open.root.dispatchEvent(new CustomEvent("quickmenuclose", { detail: { card: open.card } }));
}

function usable(control: HTMLElement) {
  if (!control.isConnected || control.closest("[hidden],[inert]")) return false;
  if (control.getAttribute("aria-disabled") === "true") return false;
  if ((control instanceof HTMLButtonElement || control instanceof HTMLInputElement) && control.disabled) return false;
  return control.getClientRects().length > 0;
}

function selectedTextIn(card: HTMLElement) {
  const selection = card.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  return card.contains(selection.anchorNode) || card.contains(selection.focusNode);
}

function place(menu: HTMLElement, x: number, y: number) {
  const view = menu.ownerDocument.documentElement;
  const width = view.clientWidth;
  const height = view.clientHeight;
  const box = menu.getBoundingClientRect();
  const left = Math.max(EDGE_PX, Math.min(x, width - box.width - EDGE_PX));
  const below = y + box.height + EDGE_PX <= height;
  const top = Math.max(EDGE_PX, Math.min(below ? y : y - box.height, height - box.height - EDGE_PX));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

export function bindCardQuickMenu(root: HTMLElement, options: QuickMenuOptions): () => void {
  const doc = root.ownerDocument;
  const view = doc.defaultView;
  const abort = new AbortController();
  const signal = abort.signal;
  let press: { pointer: number; x: number; y: number; card: HTMLElement; timer: number } | null = null;
  // Set when a long-press opened the menu: the release's click and any
  // contextmenu from the same press must not act a second time.
  let pressOpened = false;

  const cardFrom = (target: EventTarget | null) => {
    const element = target instanceof Element ? target : null;
    const card = element?.closest(options.card);
    return card instanceof HTMLElement && root.contains(card) ? card : null;
  };
  const nativeTarget = (target: EventTarget | null) =>
    target instanceof Element && Boolean(target.closest(NATIVE_TARGETS));
  const enabledActions = (card: HTMLElement) => options.actions(card).filter((action) => usable(action.control));
  const cancelPress = () => {
    if (press) view?.clearTimeout(press.timer);
    press = null;
  };

  function items(menu: HTMLElement) {
    return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  }

  function choose(action: QuickAction) {
    closeMenu();
    const control = action.control;
    if (!usable(control)) return;
    control.focus({ preventScroll: true });
    control.click();
  }

  function open(card: HTMLElement, actions: QuickAction[], at: { x: number; y: number } | null) {
    closeMenu();
    const menu = doc.createElement("div");
    menu.className = "card-quick-menu";
    menu.setAttribute("role", "menu");
    const name = (options.name?.(card) ?? card.getAttribute("aria-label") ?? card.textContent ?? "").trim();
    menu.setAttribute("aria-label", `Actions for ${name}`);
    for (const action of actions) {
      const item = doc.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.tabIndex = -1;
      item.textContent = action.label;
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        choose(action);
      });
      menu.append(item);
    }
    menu.addEventListener("keydown", (event) => {
      // The menu lives outside the board, and its keys stay with the menu.
      event.stopPropagation();
      const list = items(menu);
      const active = doc.activeElement;
      const index = active instanceof HTMLElement ? list.indexOf(active) : -1;
      const move = (to: number) => list[(to + list.length) % list.length]?.focus({ preventScroll: true });
      if (event.key === "ArrowDown") move(index + 1);
      else if (event.key === "ArrowUp") move(index < 0 ? -1 : index - 1);
      else if (event.key === "Home") move(0);
      else if (event.key === "End") move(-1);
      else if (event.key === "Enter" || event.key === " ") {
        const chosen = actions[index];
        if (chosen) choose(chosen);
      } else if (event.key === "Escape") closeMenu(true);
      else if (event.key === "Tab") {
        // Focus returns to the card and the Tab moves on from there.
        closeMenu(true);
        return;
      } else return;
      event.preventDefault();
    });
    menu.addEventListener("contextmenu", (event) => event.preventDefault());
    const focusTarget = () => {
      const target = options.focusTarget?.(card);
      return target?.isConnected ? target : card;
    };
    doc.body.append(menu);
    current = { root, card, menu, focusTarget };
    root.dataset.quickMenuOpen = "true";
    const anchor = card.getBoundingClientRect();
    place(menu, at?.x ?? anchor.left + EDGE_PX, at?.y ?? anchor.top + Math.min(anchor.height, 40));
    items(menu)[0]?.focus({ preventScroll: true });
  }

  function openFor(card: HTMLElement, at: { x: number; y: number } | null) {
    const actions = enabledActions(card);
    if (!actions.length) return false;
    open(card, actions, at);
    return true;
  }

  root.addEventListener(
    "contextmenu",
    (event) => {
      if (pressOpened) {
        event.preventDefault();
        return;
      }
      const card = cardFrom(event.target);
      if (!card || nativeTarget(event.target) || selectedTextIn(card)) return;
      const touch = press;
      cancelPress();
      // A contextmenu from the context-menu key or Shift+F10 carries no pointer
      // button; it opens at the card rather than at a stale pointer position.
      const pointerType = "pointerType" in event && typeof event.pointerType === "string" ? event.pointerType : null;
      const keyboard = !touch && event.button !== 2 && (pointerType === null || pointerType === "");
      const at = touch ? { x: touch.x, y: touch.y } : keyboard ? null : { x: event.clientX, y: event.clientY };
      if (!openFor(card, at)) return;
      event.preventDefault();
      if (touch) pressOpened = true;
    },
    { signal },
  );

  root.addEventListener(
    "keydown",
    (event) => {
      if (!(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
      const card = cardFrom(event.target);
      if (!card || nativeTarget(event.target) || selectedTextIn(card)) return;
      if (openFor(card, null)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    { signal },
  );

  root.addEventListener(
    "pointerdown",
    (event) => {
      cancelPress();
      if (event.pointerType !== "touch" || !event.isPrimary) return;
      const card = cardFrom(event.target);
      if (!card || nativeTarget(event.target)) return;
      const fire = () => {
        const held = press;
        press = null;
        if (!held?.card.isConnected) return;
        if (openFor(held.card, { x: held.x, y: held.y })) pressOpened = true;
      };
      // eslint-disable-next-line no-restricted-syntax -- One timer per touch press, cleared by cancelPress on release, move, cancel, scroll or unbind; no network reads.
      const timer = view ? view.setTimeout(fire, LONG_PRESS_MS) : 0;
      press = { pointer: event.pointerId, x: event.clientX, y: event.clientY, card, timer };
    },
    { signal },
  );

  doc.addEventListener(
    "pointermove",
    (event) => {
      if (!press || event.pointerId !== press.pointer) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) >= MOVE_TOLERANCE_PX) cancelPress();
    },
    { signal, passive: true },
  );
  const release = (event: PointerEvent) => {
    if (press && event.pointerId === press.pointer) cancelPress();
  };
  doc.addEventListener("pointerup", release, { signal });
  doc.addEventListener("pointercancel", release, { signal });

  // A long-press is never a drag: no lifted card and no move dialog.
  root.addEventListener(
    "dragstart",
    (event) => {
      if (!press && !pressOpened) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { signal, capture: true },
  );

  // The click that ends a long-press opened the menu; it must not also open the deal.
  doc.addEventListener(
    "click",
    (event) => {
      if (!pressOpened) return;
      pressOpened = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { signal, capture: true },
  );

  doc.addEventListener(
    "pointerdown",
    (event) => {
      // A new press ends the long-press that came before it.
      pressOpened = false;
      if (!current || current.root !== root) return;
      if (event.target instanceof Node && current.menu.contains(event.target)) return;
      closeMenu();
    },
    { signal, capture: true },
  );
  const dismiss = () => {
    cancelPress();
    if (current?.root === root) closeMenu();
  };
  view?.addEventListener("scroll", dismiss, { signal, capture: true, passive: true });
  view?.addEventListener("resize", dismiss, { signal });

  return () => {
    dismiss();
    abort.abort();
  };
}
