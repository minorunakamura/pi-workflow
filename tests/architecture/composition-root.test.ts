import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createWorkflowRuntime,
  type WorkflowRuntimeDependencies,
} from "../../src/bootstrap/create-workflow-runtime.js";
import type { WorkflowCommandHandler } from "../../src/application/workflow-command-handler.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const compositionRootPath = resolve(projectRoot, "src/bootstrap/create-workflow-runtime.ts");
const applicationHandlerPath = resolve(projectRoot, "src/application/workflow-command-handler.ts");

describe("composition root", () => {
  it("provides the documented runtime factory and manual injection seam", () => {
    expect(existsSync(compositionRootPath)).toBe(true);

    const handler: WorkflowCommandHandler = {
      async execute(): Promise<void> {},
    };
    const dependencies: WorkflowRuntimeDependencies = { commandHandler: handler };

    expect(createWorkflowRuntime(dependencies)).toBe(handler);
  });

  it("keeps concrete adapter construction out of application modules", () => {
    const applicationSource = readFileSync(applicationHandlerPath, "utf8");

    expect(applicationSource).not.toContain("/adapters/");
    expect(applicationSource).not.toMatch(/\bnew\s+\w*(?:Persistence|Pi|Git)\w*/);
  });

  it("assembles the production path without the fake runtime or placeholder", () => {
    const source = readFileSync(compositionRootPath, "utf8");

    for (const concrete of [
      "FileStateStore",
      "FileRunReader",
      "FileRunLock",
      "FileWorkspaceLock",
      "GitRepositoryAdapter",
      "FileArtifactStore",
      "PiSubagentsAdapter",
      "PiUserInteractionAdapter",
      "createPiPackageSkillCatalog",
      "ExecutionResolver",
      "createWorkflowUseCases",
      "new Orchestrator",
    ]) {
      expect(source).toContain(concrete);
    }
    expect(source).not.toContain("FakeAgentRuntime");
    expect(source).not.toContain("NOT_IMPLEMENTED");
  });

  it("does not introduce a Service Locator or DI container", () => {
    const compositionRootSource = readFileSync(compositionRootPath, "utf8");

    expect(compositionRootSource).not.toMatch(/\bServiceLocator\b|\bserviceLocator\b/);
    expect(compositionRootSource).not.toMatch(
      /from\s+["'][^"']*(?:inversify|tsyringe|awilix)[^"']*["']/,
    );
  });
});
