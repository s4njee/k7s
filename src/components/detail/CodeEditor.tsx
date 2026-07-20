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
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { useResolvedTheme } from "../../hooks/useTheme";

// Syntax colors (Design §4-YAML): keys secondary, strings green, numbers/bools
// amber, punctuation muted; plain values fall back to the editor body color.
const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: "var(--text-secondary)" },
  { tag: [t.string, t.special(t.string)], color: "var(--status-ok)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--status-warn)" },
  { tag: [t.punctuation, t.separator, t.meta], color: "var(--text-muted)" },
]);

/**
 * Editor chrome theme. Colors are CSS variables, so they track the palette on
 * their own; the `dark` flag can't be, since CodeMirror branches on it internally
 * to pick base styles. Hence a factory plus the compartment below.
 */
const makeTheme = (dark: boolean) =>
  EditorView.theme(
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
      ".cm-selectionBackground, ::selection": {
        backgroundColor: "var(--editor-selection)",
      },
    },
    { dark },
  );

/**
 * Lets the theme be swapped on a live editor.
 *
 * A `key` change would be the easy way to re-theme, but this editor is
 * uncontrolled and mounts with the *saved* text while the draft lives in the
 * store — so remounting mid-edit would visibly revert the user's edit. A
 * compartment reconfigures the running view and leaves the document, cursor, and
 * undo history alone.
 */
const themeCompartment = new Compartment();

interface CodeEditorProps {
  value: string;
  editable: boolean;
  /** Called with the new document text on every edit (edit mode only). */
  onChange?: (text: string) => void;
}

export function CodeEditor({ value, editable, onChange }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // YAML only mounts in the detail panel. That surface is dark under both
  // palettes (light mode keeps a dark inspector via data-surface="panel"), so
  // CodeMirror always takes the dark base path; paint colours still come from
  // inherited CSS variables and track the palette without a flag flip.
  const theme = useResolvedTheme();
  const dark = true;
  // Read through a ref inside the mount effect, which deliberately runs once.
  const darkRef = useRef(dark);
  darkRef.current = dark;

  useEffect(() => {
    if (!hostRef.current) return;

    const extensions = [
      lineNumbers(),
      yaml(),
      syntaxHighlighting(highlight),
      themeCompartment.of(makeTheme(darkRef.current)),
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

    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // Mount once; YamlTab remounts via `key` when value/editable must change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-theme in place on a palette switch; see themeCompartment. The `dark`
  // flag is stable, but re-running picks up any future theme-extension changes.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.reconfigure(makeTheme(dark)),
    });
  }, [theme, dark]);

  // Fill the available height so the editor scrolls internally.
  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, overflow: "hidden" }} />;
}
