const input = __PI_WORKFLOW_INPUT__;

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

const result = await runs.run("planning", {
  agent: "reviewer",
  context: "fresh",
  skill: "pi-planning",
  task,
  outputSchema: input.outputSchema,
});

if (!result.ok) throw new Error(result.error ?? "Planning failed.");
if (result.structuredOutput === undefined || result.structuredOutput === null) {
  throw new Error("Planning did not return structured output.");
}
if (!result.runId) throw new Error("Planning did not return a runId.");

const planningDecision = result.structuredOutput;
await state.set("planningDecision", planningDecision);
return {
  runId: result.runId,
  outputReference: result.outputReference ?? null,
  planningDecision,
};
