import { describe, it, expect } from "vitest";
import { utf8ToBase64, base64ToUtf8, bytesToBase64, base64ToBytes } from "../src/b64";

describe("base64 / utf8 codecs", () => {
  it("round-trips ascii text", () => {
    const s = "hello world\nline two\t!";
    expect(base64ToUtf8(utf8ToBase64(s))).toBe(s);
  });

  it("round-trips unicode + emoji", () => {
    const s = "café — 日本語 — 🚀 mixed";
    expect(base64ToUtf8(utf8ToBase64(s))).toBe(s);
  });

  it("matches Node's base64 for arbitrary bytes", () => {
    const bytes = [0, 1, 2, 3, 253, 254, 255, 65, 66, 67, 10, 128];
    const ours = bytesToBase64(bytes);
    expect(ours).toBe(Buffer.from(bytes).toString("base64"));
    expect(base64ToBytes(ours)).toEqual(bytes);
  });

  it("decodes known values (with padding)", () => {
    expect(base64ToUtf8("aGVsbG8=")).toBe("hello");
    expect(base64ToUtf8("aGk=")).toBe("hi");
    expect(base64ToBytes("")).toEqual([]);
  });

  it("round-trips every byte value", () => {
    const all: number[] = [];
    for (let i = 0; i < 256; i++) all.push(i);
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
  });
});
