function inlineCode(value) {
  const longestRun = Math.max(
    0,
    ...(value.match(/`+/g) ?? []).map((run) => run.length),
  );
  const delimiter = "`".repeat(longestRun + 1);
  const padding =
    value.startsWith("`") ||
    value.endsWith("`") ||
    value.startsWith(" ") ||
    value.endsWith(" ")
      ? " "
      : "";
  return `${delimiter}${padding}${value}${padding}${delimiter}`;
}

function bullets(values) {
  return values.length > 0
    ? values.map((value) => `- ${value}`).join("\n")
    : "- none";
}

function references(values) {
  return values.length > 0 ? values.map(inlineCode).join(", ") : "none";
}

function renderWorkUnits(decision) {
  return decision.implementation.workUnits
    .map((unit, index) => {
      const lines = [
        `${index + 1}. **${unit.id}** — ${unit.title}`,
        `   - Objective: ${unit.objective}`,
        `   - Depends on: ${references(unit.dependsOn)}`,
        "   - Write scope:",
        ...unit.writeScope.map((path) => `     - ${inlineCode(path)}`),
        `   - Acceptance criteria: ${references(unit.acceptanceCriteriaIds)}`,
        `   - Focused verification: ${references(unit.focusedVerificationIds)}`,
      ];
      return lines.join("\n");
    })
    .join("\n");
}

function renderVerification(decision) {
  return decision.verification
    .map((verification) => {
      const lines = [
        `- **${verification.id}** — ${verification.description}`,
        `  - Command: ${inlineCode(verification.command)}`,
      ];
      if (verification.timeoutMs !== undefined)
        lines.push(`  - Timeout: ${verification.timeoutMs} ms`);
      return lines.join("\n");
    })
    .join("\n");
}

export function renderPlan(decision) {
  return [
    "# Plan",
    "",
    "## Request",
    decision.requestSummary,
    "",
    "## Scope",
    "### In scope",
    bullets(decision.scope.inScope),
    "",
    "## Acceptance Criteria",
    decision.acceptanceCriteria
      .map((criterion) => `- **${criterion.id}** ${criterion.text}`)
      .join("\n") || "- none",
    "",
    "## Constraints",
    bullets(decision.constraints),
    "",
    "## Implementation",
    `- Mode: ${inlineCode(decision.implementation.mode)}`,
    "",
    "### Work Units",
    renderWorkUnits(decision),
    "",
    "## Verification",
    `- Final verification: ${references(decision.implementation.finalVerificationIds)}`,
    "",
    renderVerification(decision),
    "",
    "## Risks",
    bullets(decision.risks),
    "",
    "## Non-Goals",
    bullets(decision.scope.outOfScope),
    "",
  ].join("\n");
}
