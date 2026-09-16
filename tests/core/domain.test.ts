import { expect, it } from "vitest";

import type {
  FindingDisposition,
  Finding,
  PlanningHandoff,
  TrustedGate,
  ValidationResult,
} from "../../src/core/index.ts";
import {
  AUTOMATIC_RETRY_ENABLED,
  COMMON_PLANNING_REQUIREMENTS,
  CONCURRENCY_POLICY,
  MAX_AUTOMATIC_FIX_WAVES,
  MAX_CODE_REVIEW_CHANGE_CYCLES,
  MAX_PLAN_RESUBMISSIONS,
  PLAN_ARTIFACT_FILE_NAME,
  TIMEOUT_POLICY,
  TIMEOUTS,
  WORKFLOW_COMMANDS,
  WORKFLOW_TYPES,
  buildFinalGateSet,
  buildFixWave,
  canCreateFixWave,
  canResubmitPlan,
  canStartCodeReviewChangeCycle,
  canStartWorkflow,
  createFindingId,
  createImmutablePlanningHandoff,
  createInitialWorkflowState,
  createPlanningHandoff,
  createRunId,
  createWorkflowId,
  evaluateFocusedReview,
  evaluateReadyForMerge,
  evaluateTrustedGates,
  getWorkflowPolicy,
  hashPlan,
  isApprovalIdentityValid,
  isPlanHashBound,
  lifecycleStateForPhase,
  normalizeFinding,
  transitionPhase,
  validateFindingDisposition,
  validateFixWave,
  validatePlanningHandoff,
  validateRootWorkflowState,
  validateRequiredGateResolution,
  validateRequiredGatesPreserved,
} from "../../src/core/index.ts";

const UUID = "00000000-0000-4000-8000-000000000001";
const PLAN = "# Plan\r\n\r\nKeep the scope bounded";

function unwrap<T>(result: ValidationResult<T>): T {
  if (!result.valid) {
    throw new Error(result.errors.join(", "));
  }
  return result.value;
}

function makeWorkflowId() {
  return createWorkflowId(UUID);
}

function makeHandoff(planContent = PLAN): PlanningHandoff {
  return unwrap(
    createPlanningHandoff({
      workflowId: makeWorkflowId(),
      planContent,
      tddMode: "required",
      testStrategy: {
        kind: "unit",
        required: true,
        summary: "Run the focused unit tests.",
      },
      testSeams: ["core public functions"],
      constraints: ["No Pi imports in core"],
      nonGoals: ["No runtime integration"],
      planningRunId: createRunId("planning-run-1"),
    }),
  );
}

function makeGate(
  status: TrustedGate["status"],
  requirement: TrustedGate["requirement"] = "required",
  command = "pnpm check",
): TrustedGate {
  const gate: TrustedGate = {
    name: command === "pnpm check" ? "package-check" : "focused-check",
    command,
    requirement,
    status,
    source: "package-script",
  };
  if (status === "SKIPPED" || status === "UNKNOWN") {
    return {
      ...gate,
      reason: "The repository evidence does not permit this run.",
    };
  }
  return gate;
}

function makeAcceptedFinding(index: number) {
  const findingId = createFindingId(
    `00000000-0000-4000-8000-${(index + 10).toString(16).padStart(12, "0")}`,
  );
  const finding = unwrap(
    normalizeFinding(
      {
        source: "reviewer",
        evidence: `bounded evidence ${index}`,
        reason: `bounded reason ${index}`,
      },
      findingId,
    ),
  );
  return {
    finding,
    disposition: unwrap(
      validateFindingDisposition({
        findingId,
        disposition: "FIX_NOW",
        reason: "Fix it in this bounded wave.",
      }),
    ),
  };
}

it("defines the four Workflow Types and explicit command mapping", () => {
  expect(WORKFLOW_TYPES).toEqual(["feature", "bug", "chore", "hotfix"]);
  expect(WORKFLOW_COMMANDS).toEqual({
    "/wf-feature": "feature",
    "/wf-bug": "bug",
    "/wf-chore": "chore",
    "/wf-hotfix": "hotfix",
  });
});

it("limits one Root session to one active workflow without a global lock", () => {
  expect(canStartWorkflow(undefined)).toBe(true);
  expect(canStartWorkflow({ phase: "PLANNING" })).toBe(false);
  expect(canStartWorkflow({ phase: "PLAN_REVIEW" })).toBe(false);
  expect(canStartWorkflow({ phase: "READY_FOR_MERGE" })).toBe(true);
  expect(CONCURRENCY_POLICY.sameRootSession).toBe("one-active");
  expect(CONCURRENCY_POLICY.crossSessionSupported).toBe(false);
  expect(CONCURRENCY_POLICY.globalLock).toBe(false);
});

it("uses the built-in conditional planning policy and only changes Scout focus by type", () => {
  expect(COMMON_PLANNING_REQUIREMENTS).toEqual({
    scout: "required",
    "plan-composition": "required",
    researcher: "evidence-driven-conditional",
    grilling: "evidence-driven-conditional",
    "human-decision": "evidence-driven-conditional",
    "targeted-rescout": "evidence-driven-conditional",
    oracle: "evidence-driven-conditional",
  });

  const policy = getWorkflowPolicy();
  expect(policy.source).toBe("package-built-in");
  expect(policy.typePolicies.feature.scoutFocus).not.toEqual(
    policy.typePolicies.bug.scoutFocus,
  );
  expect("gates" in policy.typePolicies.feature).toBe(false);
  expect("reviewers" in policy.typePolicies.feature).toBe(false);
});

it("validates the small Root snapshot and derives lifecycle state", () => {
  const initial = createInitialWorkflowState(makeWorkflowId(), "feature");
  expect(initial.phase).toBe("IDLE");
  expect(initial.planningStatus).toBe("NOT_STARTED");
  expect(initial.implementationStatus).toBe("NOT_STARTED");
  expect(validateRootWorkflowState(initial).valid).toBe(true);
  expect(lifecycleStateForPhase("bogus")).toBeUndefined();
  expect(
    validateRootWorkflowState({ ...initial, request: "raw request" }).valid,
  ).toBe(false);
  expect(
    validateRootWorkflowState({ ...initial, phase: "PLANNING" }).valid,
  ).toBe(false);
});

it("accepts only the lifecycle transitions and rejects invalid transitions", () => {
  expect(transitionPhase("IDLE", "PLANNING")).toEqual({
    valid: true,
    phase: "PLANNING",
  });
  expect(transitionPhase("PLANNING", "PLAN_REVIEW")).toEqual({
    valid: true,
    phase: "PLAN_REVIEW",
  });
  expect(transitionPhase("PLAN_REVIEW", "IMPLEMENTING")).toEqual({
    valid: true,
    phase: "IMPLEMENTING",
  });
  expect(transitionPhase("IMPLEMENTING", "CODE_REVIEW")).toEqual({
    valid: true,
    phase: "CODE_REVIEW",
  });
  expect(transitionPhase("CODE_REVIEW", "READY_FOR_MERGE")).toEqual({
    valid: true,
    phase: "READY_FOR_MERGE",
  });
  expect(transitionPhase("IDLE", "READY_FOR_MERGE").valid).toBe(false);
  expect(
    transitionPhase("PLAN_REVIEW", "PLAN_REVIEW", {
      kind: "plan-resubmission",
      resubmissionCount: 0,
    }),
  ).toEqual({ valid: true, phase: "PLAN_REVIEW" });
  expect(
    transitionPhase("PLAN_REVIEW", "PLAN_REVIEW", {
      kind: "plan-resubmission",
      resubmissionCount: 1,
    }).valid,
  ).toBe(false);
  expect(
    transitionPhase("CODE_REVIEW", "IMPLEMENTING", {
      kind: "code-review-change-cycle",
      changeCycleCount: 0,
      sameCoordinator: true,
      approvedScope: true,
      newDecisionRequired: false,
    }),
  ).toEqual({ valid: true, phase: "IMPLEMENTING" });
  expect(lifecycleStateForPhase("PLANNING")).toBe("ACTIVE");
  expect(lifecycleStateForPhase("READY_FOR_MERGE")).toBe("TERMINAL");
});

it("canonicalizes plan bytes and binds the immutable Handoff to the plan hash", () => {
  expect(hashPlan("a\n")).toEqual(hashPlan("\uFEFFa\r\n"));
  expect(hashPlan("a")).toEqual(hashPlan("a\n"));
  expect(hashPlan("a\n\n")).not.toEqual(hashPlan("a\n"));
  expect(() => hashPlan(new Uint8Array([0xff]))).toThrow();

  const handoff = makeHandoff();
  expect(validatePlanningHandoff(handoff).valid).toBe(true);
  expect(isPlanHashBound(handoff, hashPlan(PLAN).value)).toBe(true);
  expect(isPlanHashBound(handoff, hashPlan("changed").value)).toBe(false);

  const immutable = createImmutablePlanningHandoff(handoff);
  expect(immutable.valid).toBe(true);
  if (immutable.valid) {
    expect(Object.isFrozen(immutable.value)).toBe(true);
    expect(Object.isFrozen(immutable.value.planArtifact)).toBe(true);
    expect(() => {
      (immutable.value as { kind: string }).kind = "changed";
    }).toThrow();
  }

  expect(
    validatePlanningHandoff({
      ...handoff,
      approval: true,
    }).valid,
  ).toBe(false);
  expect(
    validatePlanningHandoff({
      ...handoff,
      planArtifact: {
        path: "../implementation-plan.md",
        mediaType: "text/markdown",
      },
    }).valid,
  ).toBe(false);
});

it("accepts only a true Approval Identity bound to the current Handoff and hash", () => {
  const handoff = makeHandoff();
  const approval = {
    approvedPlanHash: handoff.planHash.value,
    reviewId: "review-opaque-1",
    approval: true as const,
  };

  expect(isApprovalIdentityValid(approval, hashPlan(PLAN).value, handoff)).toBe(
    true,
  );
  expect(isApprovalIdentityValid(approval, hashPlan(PLAN).value, handoff)).toBe(
    true,
  );
  expect(
    isApprovalIdentityValid(
      approval,
      hashPlan(PLAN).value,
      handoff.planHash.value,
    ),
  ).toBe(false);
  expect(
    isApprovalIdentityValid(approval, hashPlan(PLAN).value, {
      ...handoff,
      unexpected: true,
    }),
  ).toBe(false);
  expect(
    isApprovalIdentityValid(approval, hashPlan(PLAN).value, {
      ...handoff,
      planHash: hashPlan("changed"),
    }),
  ).toBe(false);
  expect(
    isApprovalIdentityValid(
      { ...approval, approval: false },
      hashPlan(PLAN).value,
      handoff,
    ),
  ).toBe(false);
  expect(
    isApprovalIdentityValid(
      { ...approval, approvedPlanHash: hashPlan("changed").value },
      hashPlan(PLAN).value,
      handoff,
    ),
  ).toBe(false);
  expect(
    isApprovalIdentityValid(
      { ...approval, reviewId: "\nlate" },
      hashPlan(PLAN).value,
      handoff,
    ),
  ).toBe(false);
  expect(
    isApprovalIdentityValid(approval, hashPlan(PLAN).value, {
      ...handoff,
      approval: true,
    }),
  ).toBe(false);
});

it("keeps required Gate semantics fail-closed and preserves aggregate commands", () => {
  expect(evaluateTrustedGates([makeGate("PASS")]).passed).toBe(true);
  expect(evaluateTrustedGates([makeGate("FAIL")]).passed).toBe(false);
  expect(evaluateTrustedGates([makeGate("UNKNOWN")]).passed).toBe(false);
  expect(evaluateTrustedGates([makeGate("SKIPPED")]).passed).toBe(false);
  expect(evaluateTrustedGates([makeGate("SKIPPED", "optional")]).passed).toBe(
    true,
  );

  const approved = [makeGate("PASS")];
  expect(validateRequiredGatesPreserved(approved, approved).valid).toBe(true);
  expect(
    validateRequiredGatesPreserved(approved, [makeGate("PASS", "optional")])
      .valid,
  ).toBe(false);
  expect(
    validateRequiredGateResolution(approved, [
      makeGate("PASS", "required", "pnpm test"),
    ]).valid,
  ).toBe(false);

  const final = unwrap(buildFinalGateSet(approved));
  expect(final).toHaveLength(1);
  expect(final[0]?.command).toBe("pnpm check");
  const approvedOptional: TrustedGate = {
    name: "package-check",
    command: "pnpm check",
    requirement: "optional",
    status: "PASS",
    source: "ci-config",
    evidence: {
      kind: "managed",
      path: "evidence/approved-gate.txt",
      mediaType: "text/plain",
    },
    reason: "Approved Gate record.",
  };
  const mechanicallyRequired: TrustedGate = {
    ...approvedOptional,
    requirement: "required",
  };
  const upgraded = unwrap(
    buildFinalGateSet([approvedOptional], [mechanicallyRequired]),
  );
  expect(upgraded).toEqual([{ ...approvedOptional, requirement: "required" }]);

  const alreadyRequired = unwrap(
    buildFinalGateSet(
      [{ ...approvedOptional, requirement: "required" }],
      [mechanicallyRequired],
    ),
  );
  expect(alreadyRequired).toEqual([
    { ...approvedOptional, requirement: "required" },
  ]);

  for (const conflictingGate of [
    { ...mechanicallyRequired, status: "FAIL" as const },
    { ...mechanicallyRequired, source: "package-script" as const },
    {
      ...mechanicallyRequired,
      evidence: {
        kind: "managed" as const,
        path: "evidence/different-gate.txt",
        mediaType: "text/plain" as const,
      },
    },
    { ...mechanicallyRequired, reason: "Different Gate record." },
  ]) {
    expect(buildFinalGateSet([approvedOptional], [conflictingGate])).toEqual({
      valid: false,
      errors: ["Conflicting Gate record: package-check"],
    });
  }

  expect(
    unwrap(buildFinalGateSet(approved, [])).some(
      (gate) => gate.requirement === "optional",
    ),
  ).toBe(false);
});

it("normalizes bounded Findings, requires disposition reasons, and bounds one Fix Wave", () => {
  const deterministicFindingId = createFindingId(UUID);
  const finding = unwrap(
    normalizeFinding(
      {
        source: "reviewer",
        location: "src/example.ts:4",
        evidence: "The branch is not covered.",
        reason: "The approved behavior can regress.",
        recommendedAction: "Add a regression test.",
      },
      deterministicFindingId,
    ),
  );
  expect(finding.id).toBe(deterministicFindingId);

  const dispositions = ["BLOCKER", "FIX_NOW", "DEFERRED", "REJECTED"] as const;
  const dispositioned = dispositions.map((disposition) =>
    unwrap(
      validateFindingDisposition({
        findingId: finding.id,
        disposition,
        reason: `Reason for ${disposition}`,
      }),
    ),
  );
  expect(dispositioned).toHaveLength(4);
  expect(
    validateFindingDisposition({
      findingId: finding.id,
      disposition: "BLOCKER",
      reason: "",
    }).valid,
  ).toBe(false);

  const secondFinding = unwrap(
    normalizeFinding(
      {
        source: "reviewer",
        evidence: "A second bounded issue.",
        reason: "It also needs a bounded fix.",
      },
      createFindingId("00000000-0000-4000-8000-000000000002"),
    ),
  );
  const accepted = [
    { finding, disposition: dispositioned[0]! },
    {
      finding: secondFinding,
      disposition: unwrap(
        validateFindingDisposition({
          findingId: secondFinding.id,
          disposition: "FIX_NOW",
          reason: "Fix it in this wave.",
        }),
      ),
    },
  ];
  expect(canCreateFixWave(0, accepted.length)).toBe(true);
  const wave = buildFixWave(accepted, 0);
  expect(wave.created).toBe(true);
  if (wave.created) {
    expect(wave.wave.acceptedFindingIds).toHaveLength(2);
    expect(evaluateFocusedReview(wave.wave, undefined).passed).toBe(false);
    expect(
      evaluateFocusedReview(wave.wave, {
        status: "STILL_PRESENT",
        fresh: true,
        readOnly: true,
      }).passed,
    ).toBe(false);
    expect(
      evaluateFocusedReview(wave.wave, {
        status: "RESOLVED",
        fresh: true,
        readOnly: true,
      }).passed,
    ).toBe(true);
  }
  expect(buildFixWave(accepted, MAX_AUTOMATIC_FIX_WAVES).created).toBe(false);
  expect(buildFixWave([], 0)).toEqual({
    created: false,
    reason: "NO_ACCEPTED_FINDINGS",
  });
  expect(evaluateFocusedReview(undefined, undefined)).toEqual({
    required: false,
    passed: true,
    reason: "not-applicable",
  });
});

it("keeps Fix Wave builder output within the validator bound", () => {
  const maximumFindings = Array.from({ length: 32 }, (_, index) =>
    makeAcceptedFinding(index),
  );
  const maximumWave = buildFixWave(maximumFindings);
  expect(maximumWave.created).toBe(true);
  if (maximumWave.created) {
    expect(validateFixWave(maximumWave.wave).valid).toBe(true);
  }
  expect(
    buildFixWave([...maximumFindings, makeAcceptedFinding(32)]).created,
  ).toBe(false);
  expect(canCreateFixWave(0, 32)).toBe(true);
  expect(canCreateFixWave(0, 33)).toBe(false);
});

it("enforces bounded resubmission/change-cycle counts and fixed timeout policy", () => {
  expect(MAX_PLAN_RESUBMISSIONS).toBe(1);
  expect(canResubmitPlan(0)).toBe(true);
  expect(canResubmitPlan(1)).toBe(false);
  expect(MAX_CODE_REVIEW_CHANGE_CYCLES).toBe(1);
  expect(canStartCodeReviewChangeCycle(0)).toBe(true);
  expect(canStartCodeReviewChangeCycle(1)).toBe(false);
  expect(TIMEOUTS).toEqual({
    rpcReadyTimeoutMs: 5_000,
    rpcReplyTimeoutMs: 30_000,
    coordinatorTimeoutMs: 43_200_000,
    humanDecisionTimeoutMs: 14_400_000,
    planReviewTimeoutMs: 14_400_000,
    codeReviewTimeoutMs: 14_400_000,
    gateTimeoutMs: 1_200_000,
  });
  expect(TIMEOUT_POLICY).toEqual({
    coordinator: "wall-clock",
    pauseWhileWaiting: false,
    failure: "FAILED",
  });
  expect(AUTOMATIC_RETRY_ENABLED).toBe(false);
});

function readyInput(
  overrides: Partial<Parameters<typeof evaluateReadyForMerge>[0]> = {},
) {
  const handoff = makeHandoff();
  const findingId = createFindingId(UUID);
  const base = {
    handoff,
    currentPlanHash: handoff.planHash.value,
    approval: {
      approvedPlanHash: handoff.planHash.value,
      reviewId: "review-opaque-1",
      approval: true as const,
    },
    implementationComplete: true,
    gates: [makeGate("PASS")],
    approvedGates: [makeGate("PASS")],
    requiredGateKeys: ["package-check"],
    findings: [
      {
        findingId,
        disposition: "DEFERRED" as const,
        resolved: false,
        reason: "Outside the approved scope.",
      },
    ],
    fixWave: null,
    focusedReReview: null,
    finalDiffInspection: "PASS" as const,
    codeReview: { status: "approved" as const, approved: true },
  };
  return { ...base, ...overrides };
}

it("returns Ready-for-Merge only when every blocking condition passes", () => {
  const { approvedGates: _approvedGates, ...missingBaseline } = readyInput();
  const missingBaselineResult = evaluateReadyForMerge(
    missingBaseline as Parameters<typeof evaluateReadyForMerge>[0],
  );
  expect(missingBaselineResult.ready).toBe(false);
  expect(
    missingBaselineResult.checks.find(({ id }) => id === "required-gates")
      ?.status,
  ).toBe("MISSING");

  expect(
    evaluateReadyForMerge(
      readyInput({
        approvedGates: [],
        gates: [makeGate("SKIPPED", "optional")],
        requiredGateKeys: [],
      }),
    ).ready,
  ).toBe(true);
  expect(
    evaluateReadyForMerge(
      readyInput({
        approvedGates: [makeGate("PASS")],
        gates: [makeGate("PASS", "required", "pnpm test")],
        requiredGateKeys: [],
      }),
    ).ready,
  ).toBe(false);
  expect(
    evaluateReadyForMerge(
      readyInput({
        approvedGates: [makeGate("PASS")],
        gates: [makeGate("PASS", "optional")],
        requiredGateKeys: [],
      }),
    ).ready,
  ).toBe(false);

  expect(evaluateReadyForMerge(readyInput()).ready).toBe(true);
  expect(
    evaluateReadyForMerge(readyInput({ approval: { approval: false } })).ready,
  ).toBe(false);
  expect(
    evaluateReadyForMerge(readyInput({ implementationComplete: false })).ready,
  ).toBe(false);
  expect(
    evaluateReadyForMerge(readyInput({ gates: [makeGate("FAIL")] })).ready,
  ).toBe(false);
  expect(
    evaluateReadyForMerge(readyInput({ gates: [makeGate("SKIPPED")] })).ready,
  ).toBe(false);
  expect(
    evaluateReadyForMerge(
      readyInput({
        approvedGates: [],
        gates: [makeGate("SKIPPED", "optional")],
        requiredGateKeys: [],
      }),
    ).ready,
  ).toBe(true);
  expect(
    evaluateReadyForMerge(
      readyInput({
        approvedGates: [makeGate("PASS")],
        gates: [makeGate("SKIPPED", "optional")],
        requiredGateKeys: [],
      }),
    ).ready,
  ).toBe(false);
  expect(
    evaluateReadyForMerge(
      readyInput({
        findings: [
          {
            findingId: createFindingId(UUID),
            disposition: "BLOCKER",
            resolved: false,
            reason: "Must be fixed.",
          },
        ],
      }),
    ).ready,
  ).toBe(false);
  expect(
    evaluateReadyForMerge(readyInput({ finalDiffInspection: "FAIL" })).ready,
  ).toBe(false);
  expect(
    evaluateReadyForMerge(
      readyInput({ codeReview: { status: "rejected", approved: false } }),
    ).ready,
  ).toBe(false);
});

it("does not expose Pi dependencies from core", () => {
  const finding: Finding = unwrap(
    normalizeFinding({
      source: "reviewer",
      evidence: "bounded evidence",
      reason: "bounded reason",
    }),
  );
  const disposition: FindingDisposition = unwrap(
    validateFindingDisposition({
      findingId: finding.id,
      disposition: "REJECTED",
      reason: "Not actionable in this scope.",
    }),
  );
  expect(disposition.findingId).toBe(finding.id);
  expect(PLAN_ARTIFACT_FILE_NAME).toBe("implementation-plan.md");
});
