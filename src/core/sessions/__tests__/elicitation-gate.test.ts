import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ElicitationGate,
  ElicitationValidationError,
  validateElicitationContent,
} from "../elicitation-gate.js";

function request(id = "input-1") {
  return {
    id,
    sessionId: "session-1",
    turnId: "turn-1",
    mode: "form" as const,
    message: "Choose settings",
    requestedSchema: {
      type: "object" as const,
      properties: {
        choice: { type: "string" as const, enum: ["one", "two"] },
        note: { type: "string" as const, maxLength: 20 },
        ratio: { type: "number" as const, minimum: 0, maximum: 1 },
        count: { type: "integer" as const, minimum: 1, maximum: 5 },
        enabled: { type: "boolean" as const },
        tags: { type: "array" as const, items: { type: "string" as const, enum: ["a", "b"] }, minItems: 1 },
      },
      required: ["choice", "ratio", "count", "enabled", "tags"],
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("ElicitationGate", () => {
  it("accepts and returns validated primitive form content", async () => {
    const resolved = vi.fn();
    const gate = new ElicitationGate(resolved);
    const pending = gate.request(request());

    expect(gate.resolve("input-1", {
      action: "accept",
      content: { choice: "two", note: "hello", ratio: 0.5, count: 3, enabled: true, tags: ["a"] },
    }, "telegram")).toBe("resolved");

    await expect(pending).resolves.toEqual({
      action: "accept",
      content: { choice: "two", note: "hello", ratio: 0.5, count: 3, enabled: true, tags: ["a"] },
    });
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "input-1", action: "accept", reason: "user", resolvedBy: "telegram",
    }));
  });

  it("rejects invalid, unknown, and missing content without settling", async () => {
    const gate = new ElicitationGate();
    const pending = gate.request(request());
    expect(() => gate.resolve("input-1", {
      action: "accept",
      content: { choice: "bad", count: 1.5, enabled: true, tags: [] },
    })).toThrow(ElicitationValidationError);
    expect(gate.size).toBe(1);
    gate.cancel("input-1");
    await expect(pending).resolves.toEqual({ action: "cancel" });
  });

  it.each([
    ["enum", { enum: ["one", "two"] }, "two"],
    ["oneOf", { oneOf: [{ const: "one", title: "One" }, { const: "two", title: "Two" }] }, "two"],
    [
      "combined enum and oneOf",
      {
        enum: ["shared", "enum-only"],
        oneOf: [{ const: "oneof-only", title: "OneOf only" }, { const: "shared", title: "Shared" }],
      },
      "shared",
    ],
  ])("accepts the effective %s string choice", async (_name, constraints, value) => {
    const gate = new ElicitationGate();
    const pending = gate.request({
      id: `choice-${value}`,
      sessionId: "session-1",
      mode: "form",
      message: "Choose",
      requestedSchema: {
        type: "object",
        properties: { choice: { type: "string", ...constraints } },
        required: ["choice"],
      } as any,
    });

    expect(gate.resolve(`choice-${value}`, { action: "accept", content: { choice: value } })).toBe("resolved");
    await expect(pending).resolves.toEqual({ action: "accept", content: { choice: value } });
  });

  it("enforces the intersection when enum and oneOf are both present", () => {
    const combinedRequest = {
      id: "combined",
      sessionId: "session-1",
      mode: "form" as const,
      message: "Choose",
      requestedSchema: {
        type: "object" as const,
        properties: {
          choice: {
            type: "string" as const,
            enum: ["shared", "enum-only"],
            oneOf: [{ const: "shared", title: "Shared" }, { const: "oneof-only", title: "OneOf only" }],
          },
        },
        required: ["choice"],
      },
      expiresAt: Date.now() + 1_000,
    };

    expect(() => validateElicitationContent(combinedRequest as any, { choice: "enum-only" }))
      .toThrow("choice is not an allowed option");
    expect(() => validateElicitationContent(combinedRequest as any, { choice: "oneof-only" }))
      .toThrow("choice is not an allowed option");
    expect(() => validateElicitationContent(combinedRequest as any, { choice: "shared" }))
      .not.toThrow();
  });

  it("times out once and reports duplicate and stale responses", async () => {
    vi.useFakeTimers();
    const resolved = vi.fn();
    const gate = new ElicitationGate(resolved, 50);
    const pending = gate.request(request());
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(gate.resolve("input-1", { action: "decline" })).toBe("already_resolved");
    expect(gate.resolve("missing", { action: "decline" })).toBe("not_found");
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ reason: "timeout" }));
  });

  it("cancels only requests belonging to the interrupted turn", async () => {
    const gate = new ElicitationGate();
    const first = gate.request(request("first"));
    const second = gate.request({ ...request("second"), turnId: "turn-2" });
    gate.cancelTurn("turn-1");
    await expect(first).resolves.toEqual({ action: "cancel" });
    expect(gate.get("second")).toBeDefined();
    gate.resolve("second", { action: "decline" });
    await expect(second).resolves.toEqual({ action: "decline" });
  });

  it("enforces the bounded concurrency cap", () => {
    const gate = new ElicitationGate(undefined, 60_000, 1);
    void gate.request(request("first"));
    expect(() => gate.request(request("second"))).toThrow("Too many pending input requests");
    gate.cancelAll();
  });

  it("accepts the maximum bounded free-text value without regex evaluation", async () => {
    const gate = new ElicitationGate();
    const pending = gate.request({
      id: "large-text",
      sessionId: "session-1",
      mode: "form",
      message: "Text",
      requestedSchema: {
        type: "object",
        properties: { value: { type: "string", maxLength: 32_000 } },
        required: ["value"],
      },
    });
    const value = "a".repeat(32_000);
    expect(gate.resolve("large-text", { action: "accept", content: { value } })).toBe("resolved");
    await expect(pending).resolves.toEqual({ action: "accept", content: { value } });
  });

  it.each([
    "(a|aa)+$",
    "^(a+)+$",
    "([a-z]+)*$",
    "^[a-z]+$",
    "[",
    42,
    { source: "a+" },
  ])("rejects unsupported pattern metadata without executing it: %j", (pattern) => {
    const started = performance.now();
    const schema = {
      type: "object" as const,
      properties: { value: { type: "string" as const, pattern } },
      required: ["value"],
    };
    const gate = new ElicitationGate();
    expect(() => gate.request({
      id: `pattern-${String(pattern)}`,
      sessionId: "session-1",
      mode: "form",
      message: "Pattern",
      requestedSchema: schema as any,
    })).toThrow("String patterns are not supported");

    expect(() => validateElicitationContent({
      id: "direct-pattern",
      sessionId: "session-1",
      mode: "form",
      message: "Pattern",
      requestedSchema: schema as any,
      expiresAt: Date.now() + 1_000,
    }, { value: `${"a".repeat(32_000)}!` })).toThrow("String patterns are not supported");
    expect(performance.now() - started).toBeLessThan(500);
  });
});
