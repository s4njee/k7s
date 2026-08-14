import { describe, expect, it } from "vitest";
import {
  encodeHandoff,
  HandoffAssembler,
  parseHandoffFrame,
  sha256hex,
} from "./handoff";

/** A kubeconfig with client-cert material — the transfer M9 must not truncate. */
const CERT_KUBECONFIG = `apiVersion: v1
kind: Config
current-context: freya
clusters:
- name: freya
  cluster:
    server: https://192.168.1.10:6443
    certificate-authority-data: ${"A".repeat(800)}
contexts:
- name: freya
  context: { cluster: freya, user: freya-admin }
users:
- name: freya-admin
  user:
    client-certificate-data: ${"B".repeat(1200)}
    client-key-data: ${"C".repeat(1600)}
`;

describe("handoff frames (M9)", () => {
  it("round-trips a client-cert kubeconfig across many frames", async () => {
    const frames = await encodeHandoff(CERT_KUBECONFIG, { sid: "abcd1234", chunk: 180 });
    expect(frames.length).toBeGreaterThan(10);
    expect(parseHandoffFrame(frames[0])?.sha).toHaveLength(64);

    const asm = new HandoffAssembler();
    const shuffled = [...frames].reverse();
    let result: Awaited<ReturnType<HandoffAssembler["add"]>> = { status: "ignore" };
    for (const f of shuffled) result = await asm.add(f);
    expect(result).toEqual({ status: "complete", text: CERT_KUBECONFIG });
    expect(result.status === "complete" && result.text.includes("client-key-data")).toBe(true);
  });

  it("ignores unrelated QR payloads", async () => {
    const asm = new HandoffAssembler();
    expect(await asm.add("https://example.com")).toEqual({ status: "ignore" });
    expect(await asm.add("not a frame")).toEqual({ status: "ignore" });
  });

  it("a partial sequence then reset cannot complete", async () => {
    const frames = await encodeHandoff(CERT_KUBECONFIG, { sid: "deadbeef", chunk: 200 });
    const asm = new HandoffAssembler();
    const mid = await asm.add(frames[0]);
    expect(mid.status).toBe("progress");
    asm.reset();
    expect(asm.have).toBe(0);
    let last: Awaited<ReturnType<HandoffAssembler["add"]>> = { status: "ignore" };
    for (const f of frames.slice(1)) last = await asm.add(f);
    expect(last.status).not.toBe("complete");
  });

  it("rejects a corrupted payload via the checksum", async () => {
    const frames = await encodeHandoff("hello kubeconfig\n", { sid: "cafebabe", chunk: 8 });
    const broken = frames.map((f, i) => (i === 0 ? f : f.replace(/.$/, f.endsWith("A") ? "B" : "A")));
    const asm = new HandoffAssembler();
    let last: Awaited<ReturnType<HandoffAssembler["add"]>> = { status: "ignore" };
    for (const f of broken) last = await asm.add(f);
    expect(last.status).toBe("error");
    if (last.status === "error") expect(last.reason).toMatch(/checksum/i);
  });

  it("a new session id discards the previous partial sequence", async () => {
    const a = await encodeHandoff("first\n", { sid: "11111111", chunk: 3 });
    const b = await encodeHandoff("second\n", { sid: "22222222", chunk: 3 });
    const asm = new HandoffAssembler();
    await asm.add(a[0]);
    let last: Awaited<ReturnType<HandoffAssembler["add"]>> = { status: "ignore" };
    for (const f of b) last = await asm.add(f);
    expect(last).toEqual({ status: "complete", text: "second\n" });
  });

  it("header sha matches the assembled bytes", async () => {
    const text = "tiny\n";
    const frames = await encodeHandoff(text, { sid: "0123abcd", chunk: 64 });
    const header = parseHandoffFrame(frames[0]);
    expect(header?.sha).toBe(await sha256hex(new TextEncoder().encode(text)));
  });
});
