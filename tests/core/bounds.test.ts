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
  MAX_REVIEW_DECISION_BYTES,
  MAX_REVIEW_DECISION_REQUIRED,
  MAX_REVIEW_FINDINGS,
  validateReviewDecision,
  type ReviewDecisionV1,
} from "../../src/core/review/review-decision-schema";
import {
  MAX_DISCOVERY_METADATA_ITEMS,
  MAX_IMPLEMENTATION_LANE_RESULTS,
  MAX_MISSION_STATE_BYTES,
  MAX_VERIFICATION_FIX_RUNS,
  validateDiscoveryMetadata,
  type DiscoveryMetadataV1,
  validateMissionState,
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
    expect(
      new TextEncoder().encode(textBoundary.requestSummary).byteLength,
    ).toBe(1_024);
    expect(validatePlanningDecision(textBoundary).ok).toBe(true);
    textBoundary.requestSummary += "a";
    expect(validatePlanningDecision(textBoundary).ok).toBe(false);

    const commandBoundary = planningDecision();
    commandBoundary.verification[0].command = `${"あ".repeat(682)}ab`;
    expect(
      new TextEncoder().encode(commandBoundary.verification[0].command)
        .byteLength,
    ).toBe(2_048);
    expect(validatePlanningDecision(commandBoundary).ok).toBe(true);
    commandBoundary.verification[0].command += "c";
    expect(validatePlanningDecision(commandBoundary).ok).toBe(false);

    const timeoutBoundary = planningDecision();
    timeoutBoundary.verification[0].timeoutMs = MAX_VERIFICATION_TIMEOUT_MS;
    expect(validatePlanningDecision(timeoutBoundary).ok).toBe(true);
    timeoutBoundary.verification[0].timeoutMs = MAX_VERIFICATION_TIMEOUT_MS + 1;
    expect(validatePlanningDecision(timeoutBoundary).ok).toBe(false);
    timeoutBoundary.verification[0].timeoutMs = 0;
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

function reviewDecision(): ReviewDecisionV1 {
  return {
    version: 1,
    blockers: [],
    fixNow: [],
    deferred: [],
    rejected: [],
    decisionRequired: [],
  };
}

describe("ReviewDecisionV1 bounds", () => {
  it("accepts each bucket boundary and rejects overflow", () => {
    const buckets: Array<
      [string, (value: ReviewDecisionV1, count: number) => void, number]
    > = [
      [
        "blockers",
        (value, count) =>
          (value.blockers = Array.from({ length: count }, (_, index) => ({
            id: `b-${index}`,
            source: "correctness",
            summary: "finding",
          }))),
        MAX_REVIEW_FINDINGS,
      ],
      [
        "fixNow",
        (value, count) =>
          (value.fixNow = Array.from({ length: count }, (_, index) => ({
            id: `f-${index}`,
            source: "ponytail",
            summary: "finding",
          }))),
        MAX_REVIEW_FINDINGS,
      ],
      [
        "deferred",
        (value, count) =>
          (value.deferred = Array.from({ length: count }, (_, index) => ({
            id: `d-${index}`,
            source: "correctness",
            summary: "finding",
          }))),
        MAX_REVIEW_FINDINGS,
      ],
      [
        "rejected",
        (value, count) =>
          (value.rejected = Array.from({ length: count }, (_, index) => ({
            id: `r-${index}`,
            source: "correctness",
            summary: "finding",
            reason: "not demonstrated",
          }))),
        MAX_REVIEW_FINDINGS,
      ],
      [
        "decisionRequired",
        (value, count) =>
          (value.decisionRequired = Array.from(
            { length: count },
            (_, index) => ({
              id: `q-${index}`,
              question: "question",
              context: "context",
            }),
          )),
        MAX_REVIEW_DECISION_REQUIRED,
      ],
    ];

    for (const [label, setBucket, limit] of buckets) {
      const atLimit = reviewDecision();
      setBucket(atLimit, limit);
      expect(validateReviewDecision(atLimit), label).toMatchObject({
        ok: true,
      });
      const overflow = reviewDecision();
      setBucket(overflow, limit + 1);
      expect(validateReviewDecision(overflow).ok, label).toBe(false);
    }
  });

  it("enforces identifier and multibyte text bounds", () => {
    const boundary = reviewDecision();
    boundary.blockers = [
      {
        id: "i".repeat(64),
        source: "correctness",
        summary: `${"あ".repeat(341)}a`,
      },
    ];
    expect(validateReviewDecision(boundary).ok).toBe(true);
    boundary.blockers[0].summary += "a";
    expect(validateReviewDecision(boundary).ok).toBe(false);
  });

  it("enforces the inclusive serialized aggregate limit", () => {
    const exact = reviewDecision();
    exact.blockers = Array.from({ length: 16 }, (_, index) => ({
      id: `b-${index}`,
      source: "correctness" as const,
      summary: "x".repeat(1_024),
    }));
    exact.fixNow = Array.from({ length: 6 }, (_, index) => ({
      id: `f-${index}`,
      source: "ponytail" as const,
      summary: "x".repeat(1_024),
    }));
    exact.decisionRequired = [{ id: "question", question: "q", context: "c" }];

    let exactLength: number | undefined;
    for (let length = 1; length <= 1_024; length += 1) {
      exact.decisionRequired[0].question = "q".repeat(length);
      if (jsonByteLength(exact) === MAX_REVIEW_DECISION_BYTES) {
        exactLength = length;
        break;
      }
    }

    expect(exactLength).toBeDefined();
    expect(validateReviewDecision(exact).ok).toBe(true);
    if (exactLength === undefined) return;
    exact.decisionRequired[0].question = "q".repeat(exactLength + 1);
    expect(validateReviewDecision(exact).ok).toBe(false);
  });
});

function maximumState(lastFixSummaryLength: number): unknown {
  const reference = "r".repeat(MAX_REFERENCE_BYTES - 2);
  return {
    version: 1,
    requestType: "feature",
    request: "x".repeat(8_192),
    humanDecisions: Array.from({ length: 8 }, (_, index) => ({
      id: `human-${index}`,
      value: "h".repeat(2_048),
    })),
    discoveryRef: reference,
    researchRef: reference,
    planRef: reference,
    verificationRef: reference,
    implementation: {
      version: 1,
      mode: "lanes",
      status: "completed",
      laneResults: Array.from({ length: 32 }, (_, index) => ({
        workUnitId: `unit-${index}`,
        status: "completed",
        runId: reference,
        patchRef: reference,
        handoffRef: reference,
      })),
    },
    reviewRef: {
      correctnessRef: reference,
      simplicityRef: reference,
      synthesisRef: reference,
    },
    reviewDecision: {
      version: 1,
      blockers: Array.from({ length: 16 }, (_, index) => ({
        id: `blocker-${index}`,
        source: "correctness",
        summary: "x".repeat(1_024),
      })),
      fixNow: Array.from({ length: 6 }, (_, index) => ({
        id: `fix-${index}`,
        source: "ponytail",
        summary:
          index === 5 ? "x".repeat(lastFixSummaryLength) : "x".repeat(1_024),
      })),
      deferred: [],
      rejected: [],
      decisionRequired: [{ id: "decision", question: "q", context: "c" }],
    },
  };
}

describe("DiscoveryMetadataV1 bounds", () => {
  const metadata: DiscoveryMetadataV1 = {
    version: 1 as const,
    status: "ready" as const,
    externalResearchRequired: true,
    humanClarificationRequired: false,
    uncertainties: [],
    researchQuestions: [],
  };

  it("rejects unknown fields, oversized arrays, and oversized UTF-8 text", () => {
    expect(validateDiscoveryMetadata(metadata).ok).toBe(true);

    const unknown = { ...metadata, report: "full report" };
    expect(validateDiscoveryMetadata(unknown).ok).toBe(false);

    const tooManyUncertainties = structuredClone(metadata);
    tooManyUncertainties.uncertainties = Array.from(
      { length: MAX_DISCOVERY_METADATA_ITEMS + 1 },
      (_, index) => ({
        id: `uncertainty-${index}`,
        question: "question",
        material: false,
      }),
    );
    expect(validateDiscoveryMetadata(tooManyUncertainties).ok).toBe(false);

    const oversizedQuestion = structuredClone(metadata);
    oversizedQuestion.researchQuestions = ["あ".repeat(342)];
    expect(validateDiscoveryMetadata(oversizedQuestion).ok).toBe(false);

    const oversizedAggregate = structuredClone(metadata);
    oversizedAggregate.researchQuestions = Array.from(
      { length: MAX_DISCOVERY_METADATA_ITEMS },
      () => "x".repeat(1_024),
    );
    expect(validateDiscoveryMetadata(oversizedAggregate).ok).toBe(false);
  });
});

describe("Mission state aggregate contract", () => {
  it("accepts the exact 256 KiB boundary and rejects overflow", () => {
    let exactLength: number | undefined;
    for (let length = 1; length <= 1_024; length += 1) {
      const candidate = maximumState(length);
      if (jsonByteLength(candidate) === MAX_MISSION_STATE_BYTES) {
        exactLength = length;
        break;
      }
    }

    expect(exactLength).toBeDefined();
    expect(validateMissionState(maximumState(exactLength ?? 1)).ok).toBe(true);
    if (exactLength === undefined) return;
    expect(validateMissionState(maximumState(exactLength + 1)).ok).toBe(false);
  });

  it("enforces Human, lane, and verification-fix bounds", () => {
    const humanMax = Array.from({ length: 8 }, (_, index) => ({
      id: `human-${index}`,
      value: "あ".repeat(682),
    }));
    expect(
      validateMissionState({ version: 1, humanDecisions: humanMax }).ok,
    ).toBe(true);
    humanMax[0].value += "あ";
    expect(
      validateMissionState({ version: 1, humanDecisions: humanMax }).ok,
    ).toBe(false);

    const laneResults = Array.from(
      { length: MAX_IMPLEMENTATION_LANE_RESULTS },
      (_, index) => ({
        workUnitId: `unit-${index}`,
        status: "completed" as const,
      }),
    );
    expect(
      validateMissionState({
        version: 1,
        implementation: {
          version: 1,
          mode: "lanes",
          status: "completed",
          laneResults,
        },
      }).ok,
    ).toBe(true);
    laneResults.push({ workUnitId: "overflow", status: "completed" });
    expect(
      validateMissionState({
        version: 1,
        implementation: {
          version: 1,
          mode: "lanes",
          status: "completed",
          laneResults,
        },
      }).ok,
    ).toBe(false);

    const fixRuns = Array.from(
      { length: MAX_VERIFICATION_FIX_RUNS },
      (_, index) => ({
        round: (index + 1) as 1 | 2,
        status: "completed" as const,
      }),
    );
    expect(
      validateMissionState({ version: 1, verificationFixRuns: fixRuns }).ok,
    ).toBe(true);
    fixRuns.push({ round: 1, status: "completed" });
    expect(
      validateMissionState({ version: 1, verificationFixRuns: fixRuns }).ok,
    ).toBe(false);
  });
});
