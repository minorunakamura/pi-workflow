import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renderPlan } from "../core/planning/render-plan-runtime.js";

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
