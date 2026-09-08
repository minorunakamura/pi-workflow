const input = __PI_WORKFLOW_INPUT__;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function duplicateIdIssues(items, path, message) {
  const seen = new Set();
  const issues = [];
  for (let index = 0; index < items.length; index += 1) {
    const id = items[index].id;
    if (seen.has(id)) issues.push({ path: `${path}/${index}/id`, message });
    else seen.add(id);
  }
  return issues;
}

function missingReferenceIssues(values, path, knownIds, message) {
  const issues = [];
  for (let index = 0; index < values.length; index += 1) {
    if (!knownIds.has(values[index])) {
      issues.push({
        path: `${path}/${index}`,
        message: `${message} ${values[index]}`,
      });
    }
  }
  return issues;
}

// outputSchema is the native schema gate. This second gate covers relationships
// that JSON Schema cannot express, such as WorkUnit ID references.
function semanticIssues(value) {
  if (!isRecord(value)) {
    return [{ path: "/", message: "PlanningDecisionV1 must be an object" }];
  }

  const { acceptanceCriteria, verification, implementation, unresolvedDecisions } =
    value;
  const { workUnits, finalVerificationIds } = implementation;
  const issues = [
    ...duplicateIdIssues(
      acceptanceCriteria,
      "/acceptanceCriteria",
      "acceptanceCriteria ids must be unique",
    ),
    ...duplicateIdIssues(
      verification,
      "/verification",
      "verification ids must be unique",
    ),
    ...duplicateIdIssues(
      workUnits,
      "/implementation/workUnits",
      "work unit ids must be unique",
    ),
    ...duplicateIdIssues(
      unresolvedDecisions,
      "/unresolvedDecisions",
      "unresolved decision ids must be unique",
    ),
  ];
  const acceptanceIds = new Set();
  for (const criterion of acceptanceCriteria) acceptanceIds.add(criterion.id);
  const verificationIds = new Set();
  for (const item of verification) verificationIds.add(item.id);
  const workUnitIds = new Set();
  for (const workUnit of workUnits) workUnitIds.add(workUnit.id);

  for (let index = 0; index < workUnits.length; index += 1) {
    const workUnit = workUnits[index];
    if (workUnit.writeScope.length === 0) {
      issues.push({
        path: `/implementation/workUnits/${index}/writeScope`,
        message: "writeScope must contain at least one path",
      });
    }
    for (let dependencyIndex = 0; dependencyIndex < workUnit.dependsOn.length; dependencyIndex += 1) {
      const dependency = workUnit.dependsOn[dependencyIndex];
      if (!workUnitIds.has(dependency)) {
        issues.push({
          path: `/implementation/workUnits/${index}/dependsOn/${dependencyIndex}`,
          message: `work unit ${workUnit.id} references unknown dependency ${dependency}`,
        });
      }
      if (dependency === workUnit.id) {
        issues.push({
          path: `/implementation/workUnits/${index}/dependsOn/${dependencyIndex}`,
          message: "work unit cannot depend on itself",
        });
      }
    }
    issues.push(
      ...missingReferenceIssues(
        workUnit.acceptanceCriteriaIds,
        `/implementation/workUnits/${index}/acceptanceCriteriaIds`,
        acceptanceIds,
        `work unit ${workUnit.id} references unknown acceptance criterion`,
      ),
      ...missingReferenceIssues(
        workUnit.focusedVerificationIds,
        `/implementation/workUnits/${index}/focusedVerificationIds`,
        verificationIds,
        `work unit ${workUnit.id} references unknown verification`,
      ),
    );
  }

  issues.push(
    ...missingReferenceIssues(
      finalVerificationIds,
      "/implementation/finalVerificationIds",
      verificationIds,
      "final verification references unknown verification",
    ),
  );

  if (implementation.mode === "lanes") {
    for (const workUnit of workUnits) {
      if (workUnit.dependsOn.length > 0) {
        issues.push({
          path: "/implementation/workUnits",
          message: "lane mode work units must not depend on another work unit",
        });
        break;
      }
    }
  }

  return issues;
}

function validationText(errors) {
  const lines = [];
  for (const error of errors) lines.push(`${error.path}: ${error.message}`);
  return lines.join("\n");
}

function requirePlanningResult(result, label) {
  if (!result.ok) {
    throw new Error(`${label} failed: ${result.error ?? result.output ?? "unknown error"}`);
  }
  if (result.structuredOutput === undefined || result.structuredOutput === null) {
    throw new Error(`planning-invalid: ${label} did not return structured output.`);
  }
  if (!result.runId) throw new Error(`planning-invalid: ${label} did not return a runId.`);
}

const task = [
  "Create a bounded read-only PlanningDecisionV1 for the requested change.",
  `Planning context:\n${input.task}`,
  "",
  "Define explicit scope, non-goals, acceptance criteria, risks, verification commands, WorkUnits, write scopes, and integration order.",
  "Preserve WorkUnit order exactly as the decision contract requires.",
  "Choose lanes only when WorkUnits are independent; otherwise choose single mode.",
  "Do not guess material product, architecture, policy, or risk decisions.",
  "Do not edit repository files.",
  "Return only a PlanningDecisionV1 object matching the supplied outputSchema.",
].join("\n");

await state.set("phase", "planning");

const first = await runs.run("planning", {
  agent: "reviewer",
  context: "fresh",
  skill: "pi-planning",
  task,
  outputSchema: input.outputSchema,
});
requirePlanningResult(first, "initial Planning reviewer result");

let result = first;
let correctionCount = 0;
let errors = semanticIssues(first.structuredOutput);

if (errors.length > 0) {
  correctionCount = 1;
  await state.set("planningCorrectionCount", correctionCount);

  const correctionTask = [
    task,
    "",
    "The previous PlanningDecisionV1 passed schema validation but failed semantic validation.",
    "Return a corrected PlanningDecisionV1 and fix every validation error below:",
    validationText(errors),
    "When a WorkUnit has no dependency, use dependsOn: [] exactly.",
    "Never put explanatory strings such as none, なし, or N/A in an ID reference field.",
    "ID reference fields may contain only IDs defined in this same PlanningDecisionV1.",
  ].join("\n");

  result = await runs.run("planning-correction", {
    agent: "reviewer",
    context: "fresh",
    skill: "pi-planning",
    task: correctionTask,
    outputSchema: input.outputSchema,
  });
  requirePlanningResult(result, "automatic Planning correction result");
  errors = semanticIssues(result.structuredOutput);
  if (errors.length > 0) {
    throw new Error(
      `planning-invalid: semantic validation still failed after one automatic correction:\n${validationText(errors)}`,
    );
  }
} else {
  await state.set("planningCorrectionCount", correctionCount);
}

const planningDecision = result.structuredOutput;
await state.set("planningDecision", planningDecision);
await state.set("phase", "plan-review");
return {
  runId: result.runId,
  outputReference: result.outputReference ?? null,
  planningDecision,
  planningCorrectionCount: correctionCount,
};
