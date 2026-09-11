import { describe, expect, it } from "vitest";
import { jsonByteLength } from "../../src/core/validation";
import {
  MAX_PLANNING_DECISION_BYTES,
  MAX_PLANNING_IDENTIFIER_BYTES,
  MAX_PLANNING_SCOPE_ITEMS,
  MAX_PLANNING_WORK_UNITS,
  MAX_UNRESOLVED_DECISIONS,
  MAX_VERIFICATION_TIMEOUT_MS,
  MAX_WORK_UNIT_REFERENCES,
  validatePlanningDecision,
  type PlanningDecisionV1,
} from "../../src/core/planning/planning-decision";
import {
  MAX_DISCOVERY_METADATA_ITEMS,
  MAX_HUMAN_INPUT_ENTRIES,
  MAX_MISSION_STATE_BYTES,
  MAX_REQUEST_BYTES,
  MISSION_STATE_KEYS,
  validateDiscoveryMetadata,
  validateMissionState,
  type DiscoveryMetadataV1,
} from "../../src/core/state/contracts";
import { MAX_REFERENCE_BYTES } from "../../src/core/state/references";

function planningDecision(): PlanningDecisionV1 {
  return {
    version: 1,
    requestSummary: "Add a search endpoint.",
    scope: { inScope: ["Search endpoint"], outOfScope: ["UI changes"] },
    acceptanceCriteria: [{ id: "ac-1", text: "Searches records." }],
    constraints: ["Keep the API compatible."],
    risks: ["Large result sets may be slow."],
    verification: [
      { id: "verify-1", description: "Tests pass.", command: "pnpm test" },
    ],
    implementation: {
      mode: "single",
      workUnits: [
        {
          id: "unit-1",
          title: "Implement search",
          objective: "Add the endpoint.",
          dependsOn: [],
          writeScope: ["src/api/search.ts"],
          acceptanceCriteriaIds: ["ac-1"],
          focusedVerificationIds: ["verify-1"],
        },
      ],
      finalVerificationIds: ["verify-1"],
    },
    unresolvedDecisions: [],
  };
}

function planningAtArrayLimits(): PlanningDecisionV1 {
  const decision = planningDecision();
  const workUnitIds = Array.from(
    { length: MAX_PLANNING_WORK_UNITS },
    (_, index) => `unit-${index + 1}`,
  );
  const criterionIds = Array.from({ length: 16 }, (_, index) => `ac-${index}`);
  const verificationIds = Array.from(
    { length: 16 },
    (_, index) => `verify-${index}`,
  );

  decision.scope.inScope = Array.from(
    { length: MAX_PLANNING_SCOPE_ITEMS },
    (_, index) => `in-${index}`,
  );
  decision.scope.outOfScope = Array.from(
    { length: MAX_PLANNING_SCOPE_ITEMS },
    (_, index) => `out-${index}`,
  );
  decision.acceptanceCriteria = criterionIds.map((id) => ({
    id,
    text: `criterion ${id}`,
  }));
  decision.constraints = Array.from({ length: 16 }, (_, index) => `c-${index}`);
  decision.risks = Array.from({ length: 16 }, (_, index) => `risk-${index}`);
  decision.verification = verificationIds.map((id) => ({
    id,
    description: `verification ${id}`,
    command: `pnpm test -- ${id}`,
  }));
  decision.implementation.workUnits = workUnitIds.map((id) => ({
    id,
    title: `Work ${id}`,
    objective: `Objective ${id}`,
    dependsOn: [],
    writeScope: [`src/${id}.ts`],
    acceptanceCriteriaIds: [],
    focusedVerificationIds: [],
  }));
  const first = decision.implementation.workUnits[0];
  if (!first) throw new Error("missing first WorkUnit");
  first.dependsOn = workUnitIds.slice(1, MAX_WORK_UNIT_REFERENCES + 1);
  first.writeScope = Array.from(
    { length: MAX_WORK_UNIT_REFERENCES },
    (_, index) => `src/scope-${index}.ts`,
  );
  first.acceptanceCriteriaIds = criterionIds.slice(0, MAX_WORK_UNIT_REFERENCES);
  first.focusedVerificationIds = verificationIds.slice(
    0,
    MAX_WORK_UNIT_REFERENCES,
  );
  decision.implementation.finalVerificationIds = verificationIds.slice(0, 16);
  decision.unresolvedDecisions = Array.from(
    { length: MAX_UNRESOLVED_DECISIONS },
    (_, index) => ({
      id: `decision-${index}`,
      question: `Question ${index}`,
      reason: `Reason ${index}`,
    }),
  );
  return decision;
}

describe("PlanningDecisionV1 bounds", () => {
  it("accepts every array boundary and rejects one item over", () => {
    const atLimit = planningAtArrayLimits();
    expect(validatePlanningDecision(atLimit)).toMatchObject({ ok: true });

    const overflowCases: Array<[string, (value: PlanningDecisionV1) => void]> =
      [
        ["scope", (value) => value.scope.inScope.push("overflow")],
        [
          "acceptanceCriteria",
          (value) =>
            value.acceptanceCriteria.push({ id: "overflow", text: "overflow" }),
        ],
        ["constraints", (value) => value.constraints.push("overflow")],
        ["risks", (value) => value.risks.push("overflow")],
        [
          "verification",
          (value) =>
            value.verification.push({
              id: "overflow",
              description: "overflow",
              command: "echo overflow",
            }),
        ],
        [
          "workUnits",
          (value) =>
            value.implementation.workUnits.push({
              id: "overflow",
              title: "overflow",
              objective: "overflow",
              dependsOn: [],
              writeScope: ["overflow"],
              acceptanceCriteriaIds: [],
              focusedVerificationIds: [],
            }),
        ],
        [
          "unresolvedDecisions",
          (value) =>
            value.unresolvedDecisions.push({
              id: "overflow",
              question: "overflow",
              reason: "overflow",
            }),
        ],
        [
          "WorkUnit references",
          (value) =>
            value.implementation.workUnits[0]?.dependsOn.push("unit-17"),
        ],
      ];

    for (const [label, overflow] of overflowCases) {
      const invalid = structuredClone(atLimit);
      overflow(invalid);
      expect(validatePlanningDecision(invalid).ok, label).toBe(false);
    }
  });

  it("enforces identifier, UTF-8 text, command, and timeout bounds", () => {
    const identifierBoundary = planningDecision();
    identifierBoundary.acceptanceCriteria[0].id = "i".repeat(
      MAX_PLANNING_IDENTIFIER_BYTES,
    );
    identifierBoundary.implementation.workUnits[0].acceptanceCriteriaIds = [
      identifierBoundary.acceptanceCriteria[0].id,
    ];
    expect(validatePlanningDecision(identifierBoundary).ok).toBe(true);
    identifierBoundary.acceptanceCriteria[0].id += "x";
    expect(validatePlanningDecision(identifierBoundary).ok).toBe(false);

    const textBoundary = planningDecision();
    textBoundary.requestSummary = `${"あ".repeat(341)}a`;
    expect(validatePlanningDecision(textBoundary).ok).toBe(true);
    textBoundary.requestSummary += "a";
    expect(validatePlanningDecision(textBoundary).ok).toBe(false);

    const commandBoundary = planningDecision();
    commandBoundary.verification[0].command = `${"あ".repeat(682)}ab`;
    expect(validatePlanningDecision(commandBoundary).ok).toBe(true);
    commandBoundary.verification[0].command += "c";
    expect(validatePlanningDecision(commandBoundary).ok).toBe(false);

    const timeoutBoundary = planningDecision();
    timeoutBoundary.verification[0].timeoutMs = MAX_VERIFICATION_TIMEOUT_MS;
    expect(validatePlanningDecision(timeoutBoundary).ok).toBe(true);
    timeoutBoundary.verification[0].timeoutMs = MAX_VERIFICATION_TIMEOUT_MS + 1;
    expect(validatePlanningDecision(timeoutBoundary).ok).toBe(false);
  });

  it("enforces the inclusive serialized aggregate limit", () => {
    const exact = planningDecision();
    exact.scope.inScope = Array.from({ length: 16 }, () => "x".repeat(1_024));
    exact.scope.outOfScope = Array.from({ length: 16 }, () =>
      "x".repeat(1_024),
    );

    let exactLength: number | undefined;
    for (let length = 1; length <= 1_024; length += 1) {
      exact.scope.inScope[15] = "x".repeat(length);
      if (jsonByteLength(exact) === MAX_PLANNING_DECISION_BYTES) {
        exactLength = length;
        break;
      }
    }

    expect(exactLength).toBeDefined();
    expect(validatePlanningDecision(exact).ok).toBe(true);
    if (exactLength === undefined) return;
    exact.scope.inScope[15] = "x".repeat(exactLength + 1);
    expect(validatePlanningDecision(exact).ok).toBe(false);
  });
});

describe("DiscoveryMetadataV1 bounds", () => {
  const metadata: DiscoveryMetadataV1 = {
    version: 1,
    status: "ready",
    externalResearchRequired: true,
    humanClarificationRequired: false,
    uncertainties: [],
    researchQuestions: [],
  };

  it("rejects unknown fields, oversized arrays, and oversized text", () => {
    expect(validateDiscoveryMetadata(metadata).ok).toBe(true);
    expect(
      validateDiscoveryMetadata({ ...metadata, report: "full report" }).ok,
    ).toBe(false);

    const tooMany = structuredClone(metadata);
    tooMany.uncertainties = Array.from(
      { length: MAX_DISCOVERY_METADATA_ITEMS + 1 },
      (_, index) => ({
        id: `uncertainty-${index}`,
        question: "question",
        material: false,
      }),
    );
    expect(validateDiscoveryMetadata(tooMany).ok).toBe(false);

    const oversized = structuredClone(metadata);
    oversized.researchQuestions = ["あ".repeat(342)];
    expect(validateDiscoveryMetadata(oversized).ok).toBe(false);
  });
});

describe("Planning MVP Mission state bounds", () => {
  it("exposes exactly the current state keys and rejects future keys", () => {
    expect(MISSION_STATE_KEYS).toEqual([
      "version",
      "requestType",
      "request",
      "phase",
      "humanDecisions",
      "discoveryRef",
      "discoveryMeta",
      "researchRef",
      "researchMeta",
      "planRef",
      "planningDecision",
      "planReview",
    ]);

    for (const key of [
      "missionStatus",
      "implementation",
      "verificationRef",
      "verificationStatus",
      "verificationFixRuns",
      "reviewRef",
      "reviewDecision",
      "codeApproval",
      "verificationRound",
      "reviewFixWave",
    ]) {
      expect(validateMissionState({ version: 1, [key]: "future" }).ok).toBe(
        false,
      );
    }
  });

  it("enforces bounded Human input, request, and aggregate state", () => {
    const humanDecisions = Array.from(
      { length: MAX_HUMAN_INPUT_ENTRIES },
      (_, index) => ({ id: `human-${index}`, value: "answer" }),
    );
    expect(validateMissionState({ version: 1, humanDecisions }).ok).toBe(true);
    humanDecisions.push({ id: "overflow", value: "answer" });
    expect(validateMissionState({ version: 1, humanDecisions }).ok).toBe(false);
    expect(
      validateMissionState({
        version: 1,
        request: "x".repeat(MAX_REQUEST_BYTES + 1),
      }).ok,
    ).toBe(false);

    const oversized = "r".repeat(MAX_REFERENCE_BYTES);
    expect(validateMissionState({ version: 1, planRef: oversized }).ok).toBe(
      false,
    );
    expect(MAX_MISSION_STATE_BYTES).toBe(262_144);
  });
});
