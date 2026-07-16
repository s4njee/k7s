/**
 * True when the focused element is a text-entry target (input, textarea, or a
 * contenteditable region such as CodeMirror). Keyboard shortcuts skip these so
 * typing is never hijacked.
 */
export function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || node.isContentEditable;
}
