import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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

function renderPlan(decision) {
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

const args = process.argv.slice(2);
const outputFlag = args.indexOf("--output");
const outputPath = outputFlag >= 0 ? args[outputFlag + 1] : undefined;
const inputPaths =
  outputFlag >= 0
    ? args.filter(
        (_, index) => index !== outputFlag && index !== outputFlag + 1,
      )
    : args;
const inputPath = inputPaths.toReversed().find((path) => existsSync(path));
if (!inputPath) throw new Error("A PlanningDecisionV1 input path is required.");
if (outputFlag >= 0 && !outputPath)
  throw new Error("A Plan Artifact output path is required.");

const decision = JSON.parse(readFileSync(inputPath, "utf8"));
const content = renderPlan(decision);
if (outputPath) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, { encoding: "utf8", mode: 0o600 });
  process.stdout.write("plan-artifact-written");
} else {
  process.stdout.write(content);
}
