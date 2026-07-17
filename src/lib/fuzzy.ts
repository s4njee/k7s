/**
 * Fuzzy subsequence matching and ranking for the command palette (B28).
 *
 * The ranking is what makes a palette feel right or useless, so this is a real
 * scorer rather than an `includes()`: it's the algorithm from fzy, which scores
 * *where* a match lands rather than merely that it matched. That matters for
 * Kubernetes names specifically, which are long, hyphenated and share prefixes —
 * typing "wik" should find `wiki-6b6d775f4-djpwx` before `svclb-cb8-wiki-nextra`,
 * and "argoapp" should find `argocd-application-controller-0`.
 *
 * The scoring rules, in order of weight:
 *   - **consecutive characters** beat scattered ones ("wiki" as a run beats
 *     w…i…k…i spread across a name),
 *   - **word boundaries** score well — a match after `-`, `/`, `.` or `_`, or at
 *     a camelCase hump, is where a human would look,
 *   - **leading gaps** cost a little, so an early match wins ties.
 *
 * A greedy left-to-right match would be simpler and rank badly: for "app"
 * against `argocd-application-controller`, greedy takes the `a` at index 0 and
 * then hunts for `p`, scoring a scattered match, where the run at "application"
 * is obviously what was meant. The DP below considers both and keeps the best.
 */

/** A scored match, with the matched character positions for highlighting. */
export interface FuzzyMatch {
  /** Higher is better. Only comparable between matches on the same query. */
  score: number;
  /** Indices into the target of each matched query character, ascending. */
  indices: number[];
}

// Weights from fzy. Gaps are small negatives so a long name isn't punished for
// its length; the match bonuses do the real work.
const GAP_LEADING = -0.005;
const GAP_TRAILING = -0.005;
const GAP_INNER = -0.01;
const MATCH_CONSECUTIVE = 1.0;
const MATCH_SLASH = 0.9;
const MATCH_WORD = 0.8;
const MATCH_CAPITAL = 0.7;
const MATCH_DOT = 0.6;

/** Score floor standing in for -infinity; every real score is far above it. */
const MIN = -Infinity;

/**
 * Beyond this length, scoring costs more than the result is worth. Nothing we
 * match against is close (the longest Kubernetes name is 253 chars), so this is
 * a guard against a pathological input rather than a real limit.
 */
const MAX_LEN = 512;

/**
 * Per-position bonus for matching at `i`, decided by the character *before* it:
 * matching the first letter of a word is worth more than matching mid-word.
 */
function bonusAt(target: string, i: number): number {
  if (i === 0) return MATCH_SLASH; // start of the string reads like a boundary
  const prev = target[i - 1];
  const cur = target[i];
  if (prev === "/") return MATCH_SLASH;
  if (prev === "-" || prev === "_" || prev === " ") return MATCH_WORD;
  if (prev === ".") return MATCH_DOT;
  // camelCase hump: "IngressRoute" should match "route" at the R.
  if (prev >= "a" && prev <= "z" && cur >= "A" && cur <= "Z") return MATCH_CAPITAL;
  return 0;
}

/**
 * Match `query` against `target`, case-insensitively. Returns null when the
 * query isn't a subsequence of the target — i.e. when it doesn't match at all.
 *
 * An empty query matches everything with score 0, which lets callers use the
 * same path for "show me the default list".
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query === "") return { score: 0, indices: [] };
  if (query.length > target.length) return null;
  if (target.length > MAX_LEN) return null;

  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Cheap reject: most candidates fail here, so the DP below only ever runs on
  // strings that can actually match.
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  if (qi !== q.length) return null;

  const n = q.length;
  const m = t.length;

  // An exact case-insensitive equality is the best possible match; skip the DP.
  if (n === m) {
    return { score: Infinity, indices: Array.from({ length: n }, (_, i) => i) };
  }

  const bonus = new Float64Array(m);
  for (let i = 0; i < m; i++) bonus[i] = bonusAt(target, i);

  // D[i][j]: best score for query[0..i] where query[i] is matched *at* j.
  // M[i][j]: best score for query[0..i] within target[0..j], however it ends.
  // Two rows of each would do; the full grids are kept because the traceback
  // that recovers the matched positions reads them.
  const D: Float64Array[] = [];
  const M: Float64Array[] = [];

  for (let i = 0; i < n; i++) {
    D.push(new Float64Array(m).fill(MIN));
    M.push(new Float64Array(m).fill(MIN));
    const dRow = D[i];
    const mRow = M[i];
    const dPrev = i > 0 ? D[i - 1] : null;
    const mPrev = i > 0 ? M[i - 1] : null;

    let prevScore = MIN;
    // The last query character may sit anywhere, so trailing gaps are cheap.
    const gap = i === n - 1 ? GAP_TRAILING : GAP_INNER;

    for (let j = 0; j < m; j++) {
      if (q[i] === t[j]) {
        let score = MIN;
        if (i === 0) {
          // First character: pay for everything skipped to reach it.
          score = j * GAP_LEADING + bonus[j];
        } else if (j > 0 && mPrev && dPrev) {
          // Either start a fresh run here (taking j's bonus), or extend the run
          // that ended at j-1 (taking the consecutive bonus) — whichever is better.
          score = Math.max(mPrev[j - 1] + bonus[j], dPrev[j - 1] + MATCH_CONSECUTIVE);
        }
        dRow[j] = score;
        prevScore = Math.max(score, prevScore + gap);
        mRow[j] = prevScore;
      } else {
        dRow[j] = MIN;
        prevScore = prevScore + gap;
        mRow[j] = prevScore;
      }
    }
  }

  return { score: M[n - 1][m - 1], indices: traceback(D, M, n, m) };
}

/**
 * Recover which positions were matched, by walking the grids backwards.
 *
 * At each step the question is whether query[i] was matched at j: it was if D
 * and M agree there, since M only equals D when the best path through j ends
 * with a match. Walking right-to-left keeps the *last* such position, which is
 * the one the forward pass scored.
 */
function traceback(D: Float64Array[], M: Float64Array[], n: number, m: number): number[] {
  const indices: number[] = [];
  let matchRequired = false;

  for (let i = n - 1, j = m - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      // D[i][j] > MIN means query[i] *can* end here; the M equality means the
      // best path actually does.
      if (D[i][j] !== MIN && (matchRequired || D[i][j] === M[i][j])) {
        // A consecutive run forces the previous character to be at j-1.
        matchRequired = i > 0 && j > 0 && M[i][j] === D[i - 1][j - 1] + MATCH_CONSECUTIVE;
        indices.push(j);
        j--;
        break;
      }
    }
  }

  return indices.reverse();
}
