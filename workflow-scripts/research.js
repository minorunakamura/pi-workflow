const input = __PI_WORKFLOW_INPUT__;

let questionText = "";
if (input.questions?.length) {
  questionText = "Questions:\n";
  for (const question of input.questions) questionText += `- ${question}\n`;
}

const task = [
  "Collect external evidence needed for the requested change.",
  `Request and research context:\n${input.task}`,
  questionText,
  "",
  "Use primary sources when possible.",
  "Return evidence and uncertainty only; do not make product, architecture, policy, or risk-acceptance decisions.",
].join("\n");

const result = await runs.run("research", {
  agent: "pi-ketch.researcher",
  context: "fresh",
  task,
  output: input.outputPath,
  outputMode: "file-only",
});

if (!result.ok) throw new Error(result.error ?? "External research failed.");
if (!result.runId) throw new Error("External research did not return a runId.");

const research = {
  runId: result.runId,
  outputReference: result.outputReference ?? null,
};
await state.set("research", research);
return research;
