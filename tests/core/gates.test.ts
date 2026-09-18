import { expect, it } from "vitest";

import {
  buildFinalGateSet,
  evaluateTrustedGates,
  validateRequiredGateResolution,
  validateRequiredGatesPreserved,
  type TrustedGate,
} from "../../src/core/index.ts";

function gate(
  status: TrustedGate["status"],
  overrides: Partial<TrustedGate> = {},
): TrustedGate {
  return {
    name: "package-check",
    command: "pnpm check",
    requirement: "required",
    status,
    source: "package-script",
    ...(status === "PASS"
      ? {
          evidence: {
            kind: "managed" as const,
            path: "evidence/package-check.log",
            mediaType: "text/plain" as const,
          },
        }
      : {}),
    ...(status === "SKIPPED" || status === "UNKNOWN"
      ? { reason: "The command could not be safely established." }
      : {}),
    ...overrides,
  };
}

it("requires managed evidence for PASS without changing status semantics", () => {
  const noEvidence = { ...gate("PASS") };
  delete noEvidence.evidence;
  expect(evaluateTrustedGates([noEvidence]).valid).toBe(false);
  expect(evaluateTrustedGates([gate("PASS")]).passed).toBe(true);
  expect(evaluateTrustedGates([gate("FAIL")]).valid).toBe(true);
});

it("blocks required gates while allowing an optional skipped gate", () => {
  expect(evaluateTrustedGates([gate("FAIL")]).passed).toBe(false);
  expect(evaluateTrustedGates([gate("UNKNOWN")]).passed).toBe(false);
  expect(evaluateTrustedGates([gate("SKIPPED")]).passed).toBe(false);
  expect(
    evaluateTrustedGates([gate("SKIPPED", { requirement: "optional" })]).passed,
  ).toBe(true);
});

it("fails closed when the approved required gate drifts", () => {
  const approved = [gate("PASS")];
  expect(
    validateRequiredGateResolution(approved, [gate("UNKNOWN")]).valid,
  ).toBe(true);
  expect(
    validateRequiredGateResolution(approved, [
      gate("PASS", { command: "pnpm test" }),
    ]).valid,
  ).toBe(false);
  expect(
    validateRequiredGateResolution(approved, [
      gate("PASS", { source: "ci-config" }),
    ]).valid,
  ).toBe(false);
  expect(
    validateRequiredGatesPreserved(approved, [
      gate("PASS", { requirement: "optional" }),
    ]).valid,
  ).toBe(false);
});

it("does not invent gates and preserves an aggregate command", () => {
  const approved = [gate("PASS")];
  const unchanged = buildFinalGateSet(approved);
  expect(unchanged.valid && unchanged.value).toEqual(approved);
  expect(unchanged.valid && unchanged.value[0]?.command).toBe("pnpm check");

  const additional = gate("UNKNOWN", {
    name: "generated-check",
    command: "pnpm test",
    reason: "Mechanically required by the changed test area.",
  });
  const final = buildFinalGateSet(approved, [additional]);
  expect(final.valid).toBe(true);
  expect(final.valid && final.value.map(({ command }) => command)).toEqual([
    "pnpm check",
    "pnpm test",
  ]);
});
