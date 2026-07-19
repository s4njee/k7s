/**
 * Line diff for the YAML dry-run preview (B36).
 *
 * The question this answers is "what will applying actually do", and the honest
 * answer comes from the *server*: `dryRun=All` runs defaulting and mutating
 * webhooks, so the object that would be stored is often not the text you typed.
 * This diffs the live object against that, so webhook rewrites and defaulted
 * fields are visible before anything is written.
 *
 * A YAML document is mostly unchanged, so the output is grouped into **hunks**
 * with a few lines of context rather than returned whole — a one-line change in
 * a 300-line manifest should read as one line, not require scrolling.
 */

/** What happened to a line. */
export type DiffOp = "same" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the "before" text; undefined for additions. */
  before?: number;
  /** 1-based line number in the "after" text; undefined for deletions. */
  after?: number;
}

/**
 * Longest-common-subsequence line diff.
 *
 * O(n·m) in lines, which is fine for the sizes involved (a large manifest is a
 * few hundred lines) and gives a minimal, stable diff — a greedy scan would
 * resynchronise badly on YAML, where blocks of similar keys repeat.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "same", text: a[i], before: i + 1, after: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      // Deletions before additions, so a changed line reads as -old / +new.
      out.push({ op: "del", text: a[i], before: i + 1 });
      i++;
    } else {
      out.push({ op: "add", text: b[j], after: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ op: "del", text: a[i], before: ++i });
  while (j < m) out.push({ op: "add", text: b[j], after: ++j });
  return out;
}

/** True when the two texts differ at all. */
export function hasChanges(lines: DiffLine[]): boolean {
  return lines.some((l) => l.op !== "same");
}

/**
 * Group a diff into hunks of changed lines plus `context` unchanged lines either
 * side, dropping the untouched remainder. Adjacent hunks that would overlap are
 * merged, so context never repeats.
 *
 * An unchanged document yields no hunks at all — the caller says "no changes"
 * rather than rendering the whole file as context.
 */
export function hunks(lines: DiffLine[], context = 3): DiffLine[][] {
  const changed = lines.map((l) => l.op !== "same");
  if (!changed.some(Boolean)) return [];

  // Mark every line within `context` of a change as worth keeping.
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!changed[i]) continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) {
      keep[k] = true;
    }
  }

  const out: DiffLine[][] = [];
  let current: DiffLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      current.push(lines[i]);
    } else if (current.length) {
      out.push(current);
      current = [];
    }
  }
  if (current.length) out.push(current);
  return out;
}

/** Added/removed line counts, for a one-line summary above the diff. */
export function diffStat(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "add") added++;
    else if (l.op === "del") removed++;
  }
  return { added, removed };
}
