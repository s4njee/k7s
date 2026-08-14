/**
 * Resource bookmarks (B56): the same 5–10 resources a power user monitors, one
 * click away in the sidebar. A bookmark is a resource ref — kind (nav id),
 * optional namespace, name — and it's keyed the same way the palette ranks
 * objects, so bookmarked items can be boosted there.
 */

import type { Bookmark } from "../providers/types";

export type { Bookmark };

/** The stable key for a bookmark, "{kind}:{namespace}/{name}". */
export function bookmarkKey(b: Bookmark): string {
  return `${b.kind}:${b.namespace ?? ""}/${b.name}`;
}

/** Whether two bookmarks refer to the same resource. */
export function sameBookmark(a: Bookmark, b: Bookmark): boolean {
  return (
    a.kind === b.kind &&
    (a.namespace ?? "") === (b.namespace ?? "") &&
    a.name === b.name
  );
}
