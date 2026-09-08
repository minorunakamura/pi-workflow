import { describe, expect, it } from "vitest";
import { renderPlan } from "../../src/core/planning/render-plan";
import type { PlanningDecisionV1 } from "../../src/core/planning/planning-decision";

const decision: PlanningDecisionV1 = {
  version: 1,
  requestSummary: "Add a search endpoint.",
  scope: {
    inScope: ["HTTP search endpoint"],
    outOfScope: ["UI changes"],
  },
  acceptanceCriteria: [{ id: "ac-search", text: "Returns matching records." }],
  constraints: ["Keep the public API backward compatible."],
  risks: ["Large result sets may be slow."],
  verification: [
    {
      id: "verify-search",
      description: "Search tests pass.",
      command: "pnpm test -- search",
      timeoutMs: 120_000,
    },
  ],
  implementation: {
    mode: "single",
    workUnits: [
      {
        id: "search-api",
        title: "Implement the search endpoint",
        objective: "Expose search through the existing API.",
        dependsOn: [],
        writeScope: ["src/api/search.ts"],
        acceptanceCriteriaIds: ["ac-search"],
        focusedVerificationIds: ["verify-search"],
      },
    ],
    finalVerificationIds: ["verify-search"],
  },
  unresolvedDecisions: [],
};

describe("renderPlan", () => {
  it("uses a longer code span delimiter for values containing backticks", () => {
    const rendered = renderPlan({
      ...decision,
      verification: [{ ...decision.verification[0], command: "echo `date`" }],
    });

    expect(rendered).toContain("- Command: `` echo `date` ``");
  });

  it("renders the same PlanningDecisionV1 deterministically", () => {
    const first = renderPlan(decision);
    const second = renderPlan(structuredClone(decision));

    expect(first).toBe(second);
    expect(first).toBe(`# Plan

## Request
Add a search endpoint.

## Scope
### In scope
- HTTP search endpoint

## Acceptance Criteria
- **ac-search** Returns matching records.

## Constraints
- Keep the public API backward compatible.

## Implementation
- Mode: \`single\`

### Work Units
1. **search-api** — Implement the search endpoint
   - Objective: Expose search through the existing API.
   - Depends on: none
   - Write scope:
     - \`src/api/search.ts\`
   - Acceptance criteria: \`ac-search\`
   - Focused verification: \`verify-search\`

## Verification
- Final verification: \`verify-search\`

- **verify-search** — Search tests pass.
  - Command: \`pnpm test -- search\`
  - Timeout: 120000 ms

## Risks
- Large result sets may be slow.

## Non-Goals
- UI changes
`);
  });
});
