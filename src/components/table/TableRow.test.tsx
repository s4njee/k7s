/**
 * B75 injection surface: cluster-supplied strings (pod names, log lines, event
 * messages, CRD column values) are attacker-influenced input. They must render
 * as *text* — React's default escaping — never as HTML. The app has no
 * `dangerouslySetInnerHTML` anywhere (grep proves it); this test pins the
 * rendering path so a regression can't slip in: a pod named
 * `<img src=x onerror=alert(1)>` appears as that literal text, and no
 * `<img>` or `onerror` attribute ever reaches the DOM.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderComponent } from "../../hooks/testUtils";
import { renderCell, TableRow } from "./TableRow";
import type { Row } from "../../providers/types";

const HOSTILE = '<img src=x onerror=alert(1)>';

function hostileRow(): Row {
  return {
    uid: "pod/hostile",
    name: HOSTILE,
    namespace: "default",
    cells: [
      { text: HOSTILE, tone: "ok" },
      { text: "1/1", tone: "ok" },
    ],
  };
}

describe("cluster-supplied strings render as text (B75)", () => {
  beforeEach(cleanup);

  it("a hostile pod name never becomes HTML in the table", () => {
    const container = renderComponent(
      // A <tr> needs a table ancestor to render without a hydration warning.
      <table>
        <tbody>
          <TableRow
            row={hostileRow()}
            index={0}
            virtual={false}
            clickable
            selected={false}
            inSelection={false}
            highlight={false}
            now={0}
            onSelect={() => {}}
            onContextMenu={() => {}}
          />
        </tbody>
      </table>,
    );

    // The literal string is present, as text…
    expect(container.textContent).toContain(HOSTILE);
    // …but it was not parsed into elements or attribute handlers.
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
  });

  it("the same hostile string survives the cell formatter", () => {
    // renderCell is the one transformation between a cluster string and the
    // <td>; it must pass the text through untouched (formatting excepted).
    const text = renderCell({ text: HOSTILE, tone: "ok" }, 0);
    expect(text).toBe(HOSTILE);
  });
});
