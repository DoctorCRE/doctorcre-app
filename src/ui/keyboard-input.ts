export function isTextEntry(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) return true;
  const target = event.target;
  const editable =
    target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  return event.ctrlKey && event.altKey && !event.metaKey && Array.from(event.key).length === 1 && editable;
}

const isEditable = (node: unknown): boolean =>
  node instanceof HTMLElement && (node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName));

// Single-key page shortcuts stand down while a person is typing, composing or
// holding a command modifier. Shift alone does not block, so '?' still works.
export function blocksShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) return true;
  if (event.ctrlKey || event.metaKey || event.altKey) return true;
  return isEditable(event.target) || isEditable(document.activeElement);
}

export function submitOnEnter(event: KeyboardEvent, submit: () => void): void {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.defaultPrevented ||
    isTextEntry(event)
  )
    return;
  event.preventDefault();
  if (!event.repeat) submit();
}
