import { describe, it, expect } from "vitest";
import { dispatch } from "../src/lib";
import { preview } from "../src/activity";

describe("dispatch", () => {
  it("skips unknown hooks", () => {
    expect(JSON.parse(dispatch("something.else", {}))).toEqual({ verdict: "skip" });
  });

  it("cancels a malformed invoke payload", () => {
    const v = JSON.parse(dispatch("mcp.tool.invoke", "not-an-object"));
    expect(v.verdict).toBe("cancel");
  });

  it("cancels an unknown tool by name", () => {
    const v = JSON.parse(dispatch("mcp.tool.invoke", { tool: "bogus_tool", arguments: {} }));
    expect(v.verdict).toBe("cancel");
    expect(v.reason).toContain("bogus_tool");
  });
});

describe("activity preview", () => {
  it("passes short strings through", () => {
    expect(preview("short")).toBe("short");
  });
  it("drops empty/undefined", () => {
    expect(preview("")).toBeUndefined();
    expect(preview(undefined)).toBeUndefined();
  });
  it("truncates long output with a marker", () => {
    const p = preview("x".repeat(1000))!;
    expect(p.length).toBeLessThan(500);
    expect(p).toContain("truncated");
  });
});
