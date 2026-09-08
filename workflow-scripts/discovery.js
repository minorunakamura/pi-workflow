const input = __PI_WORKFLOW_INPUT__;

await state.set("phase", "discovery");

const task = [
  "Inspect the current repository for the requested change.",
  `Request:\n${input.task}`,
  "",
  "Discovery policy:",
  "1. Run `codegraph status` first when the CodeGraph CLI is available.",
  "2. If CodeGraph is usable, use `codegraph explore` for structural questions.",
  "3. Read exact source only where CodeGraph is stale, changed on disk, or insufficient.",
  "4. If CodeGraph is unavailable or unusable, use bounded read, grep, find, and ls inspection.",
  "5. Never run codegraph init, index, sync, or upgrade.",
  "",
  "Do not modify repository source files.",
  "Return only a DiscoveryResultV1 object matching the supplied outputSchema.",
].join("\n");

const result = await runs.run("discovery", {
  agent: "scout",
  context: "fresh",
  task,
  outputSchema: input.outputSchema,
  ...(input.outputPath === undefined
    ? {}
    : { output: input.outputPath, outputMode: "file-only" }),
});

if (!result.ok) throw new Error(result.error ?? "Discovery failed.");
if (result.structuredOutput === undefined || result.structuredOutput === null) {
  throw new Error("Discovery did not return structured output.");
}
if (!result.runId) throw new Error("Discovery did not return a runId.");

const discovery = {
  runId: result.runId,
  outputReference: result.outputReference ?? null,
  result: result.structuredOutput,
};
await state.set("discovery", discovery);
return {
  runId: discovery.runId,
  outputReference: discovery.outputReference,
  discovery: discovery.result,
};
