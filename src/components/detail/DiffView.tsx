/**
 * The hunk diff of two YAML documents (B36/B54): changed regions with a few
 * lines of context, plus a one-line summary. Shared by the apply-preview in the
 * YAML tab and the resource Diff tab, so the two can't render differently.
 *
 * Styles come from YamlTab.module.css — the diff was born there, and both
 * surfaces are detail-panel chrome.
 */

import styles from "./YamlTab.module.css";
import { diffLines, diffStat, hasChanges, hunks } from "../../lib/diff";
import type { YamlDiff } from "../../providers/types";

/** True when this pair of texts differs at all. */
export function yamlHasChanges(before: string, after: string): boolean {
  return hasChanges(diffLines(before, after));
}

export function DiffView({
  diff,
  note = "live vs last-applied",
  empty = "No changes — the two objects are identical.",
}: {
  diff: YamlDiff;
  /** What the "before" and "after" mean — the apply-preview says so specifically. */
  note?: string;
  /** The all-clear message when nothing changed. */
  empty?: string;
}) {
  const lines = diffLines(diff.current, diff.proposed);
  const groups = hunks(lines);
  const { added, removed } = diffStat(lines);

  if (!hasChanges(lines)) {
    return (
      <div className={styles.diffWrap}>
        <div className={styles.diffEmpty}>{empty}</div>
      </div>
    );
  }

  return (
    <div className={styles.diffWrap}>
      <div className={styles.diffStat}>
        <span className={styles.diffAdded}>+{added}</span>{" "}
        <span className={styles.diffRemoved}>−{removed}</span>{" "}
        <span className={styles.diffNote}>{note}</span>
      </div>
      {groups.map((g, i) => (
        <div className={styles.diffHunk} key={i}>
          {g.map((l, j) => (
            <div
              key={j}
              className={[
                styles.diffLine,
                l.op === "add" ? styles.diffLineAdd : "",
                l.op === "del" ? styles.diffLineDel : "",
              ].join(" ")}
            >
              <span className={styles.diffGutter}>{l.before ?? l.after ?? ""}</span>
              <span className={styles.diffSign}>
                {l.op === "add" ? "+" : l.op === "del" ? "−" : " "}
              </span>
              <span className={styles.diffText}>{l.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
