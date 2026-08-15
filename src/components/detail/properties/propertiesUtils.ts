/**
 * Shared formatting and layout helpers for property views.
 */

import { formatAge } from "../../../lib/format";
import type { Cell } from "../../../providers/types";

/** Cell text, formatting age cells like the resource tables do. */
export function cellText(cell: Cell, now: number): string {
  return cell.format === "age" ? formatAge(cell.text, now) : cell.text;
}

/**
 * Length past which a value is allowed to wrap instead of holding the column open.
 * Sized to sit above the values that should stay on one line ("100m / 1",
 * "8080/TCP", "ReadWriteOnce") and below the ones that shouldn't hold a column
 * open (images, PV names, mount paths, condition messages).
 */
const WRAP_AT = 24;

/**
 * Whether a cell may wrap. Decided by the value, not the column: the renderer is
 * generic, so it can't know that column 2 is an image here and a phase there —
 * but it can see that "registry.freya.io/valkyrie-api:2.14.0" needs to wrap and
 * "Running" does not. Wrapping short values would let them break mid-token.
 */
export function wraps(cell: Cell): boolean {
  // Ages are rendered short ("4d2h") whatever the timestamp's length.
  if (cell.format === "age") return false;
  return cell.text.length > WRAP_AT;
}
