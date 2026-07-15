/**
 * A thin CodeMirror 6 wrapper for the YAML tab, themed to the design tokens
 * (Design §4-YAML): terminal background, mono 11.5px, right-aligned line numbers,
 * and syntax colors for keys/strings/numbers/punctuation.
 *
 * The editor is uncontrolled after mount; YamlTab gives it a React `key` that
 * changes on pod switch / edit-mode toggle, so it remounts with fresh content
 * rather than fighting React over the document state.
 */

import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Syntax colors (Design §4-YAML): keys secondary, strings green, numbers/bools
// amber, punctuation muted; plain values fall back to the editor body color.
const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: "var(--text-secondary)" },
  { tag: [t.string, t.special(t.string)], color: "var(--status-ok)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--status-warn)" },
  { tag: [t.punctuation, t.separator, t.meta], color: "var(--text-muted)" },
]);

// Editor chrome theme.
const theme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--bg-terminal)",
      color: "var(--text-body)",
      fontSize: "11.5px",
      height: "100%",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.6",
      padding: "10px 0",
    },
    ".cm-scroller": { fontFamily: "var(--font-mono)", overflow: "auto" },
    "&.cm-focused": { outline: "none" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-terminal)",
      color: "var(--text-linenum)",
      border: "none",
    },
    // Right-aligned 30px line-number column.
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 14px 0 6px",
      minWidth: "30px",
      textAlign: "right",
    },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-activeLineGutter": { backgroundColor: "transparent" },
    ".cm-line:hover": { backgroundColor: "var(--bg-log-hover)" },
    ".cm-cursor": { borderLeftColor: "var(--accent)" },
    ".cm-selectionBackground, ::selection": { backgroundColor: "#23324a" },
  },
  { dark: true },
);

interface CodeEditorProps {
  value: string;
  editable: boolean;
  /** Called with the new document text on every edit (edit mode only). */
  onChange?: (text: string) => void;
}

export function CodeEditor({ value, editable, onChange }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const extensions = [
      lineNumbers(),
      yaml(),
      syntaxHighlighting(highlight),
      theme,
      EditorView.lineWrapping,
      EditorState.readOnly.of(!editable),
      EditorView.editable.of(editable),
    ];

    if (editable) {
      // History + standard editing keybindings only when editable.
      extensions.push(history(), keymap.of([...defaultKeymap, ...historyKeymap]));
      if (onChange) {
        extensions.push(
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChange(u.state.doc.toString());
          }),
        );
      }
    }

    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    });

    return () => view.destroy();
    // Mount once; YamlTab remounts via `key` when value/editable must change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fill the available height so the editor scrolls internally.
  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, overflow: "hidden" }} />;
}
