import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { JsonlEventReader } from "../../src/adapters/persistence/read/jsonl-event-reader.js";
import { FileStateStore } from "../../src/adapters/persistence/write/file-state-store.js";
import { Orchestrator } from "../../src/application/orchestrator.js";
import { StartWorkflowUseCase } from "../../src/application/workflow-use-cases.js";
import type { RepositoryAdapter, RepositorySnapshot } from "../../src/ports/repository.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import { withTempRepository } from "../fixtures/temp-repository.js";

const CREATED_AT = "2026-08-30T03:02:10.123Z";

function snapshot(root: string): RepositorySnapshot {
  return {
    root,
    head: "abc123",
    branch: "main",
    status: { dirty: false, changed: [], untracked: [], entries: [] },
    fingerprints: {},
    fingerprint: "repository-fingerprint",
  };
}

describe("production workflow bootstrap integration", () => {
  it("persists the canonical Run Store before entering the Orchestrator", async () => {
    await withTempRepository({}, async (repositoryRoot) => {
      const runReader = new FileRunReader(repositoryRoot);
      const stateStore = new FileStateStore(repositoryRoot);
      const orchestrator = new Orchestrator({
        runReader,
        stateStore,
        agentRuntime: {
          async run() {
            throw new Error("Agent execution is not expected for this bootstrap check");
          },
        },
        buildRequest: async () => {
          throw new Error("Request building is not expected for this bootstrap check");
        },
        completion: async () => ({
          eligible: false,
          blockers: ["STEP_INCOMPLETE"] as const,
        }),
        schedule: async () => ({ kind: "idle" as const, reason: "GRAPH_NO_PROGRESS" as const }),
        fixCycle: false,
      });
      const repository: RepositoryAdapter = {
        getRoot: async () => repositoryRoot,
        getHead: async () => "abc123",
        getBranch: async () => "main",
        captureSnapshot: async () => snapshot(repositoryRoot),
        diff: async () => {
          throw new Error("diff is not used during initial bootstrap");
        },
      };

      const result = await new StartWorkflowUseCase({
        runStore: stateStore,
        repository,
        orchestrator,
        now: () => new Date(CREATED_AT),
      }).execute("bug", "  fix the bug  ");

      expect(result.run).toMatchObject({
        run_id: "run-001",
        status: "running",
        finalized: false,
        request: { type: "bug" },
        playbook: { initial: { id: "bug", version: "1.0.0" } },
      });
      expect(result.snapshot.requirement.goal).toBe("fix the bug");
      expect(result.snapshot.steps.steps.map(({ status }) => status)).toEqual([
        "ready",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
        "pending",
      ]);

      const runRoot = join(repositoryRoot, ".pi", "runs", "run-001");
      await expect(readFile(join(runRoot, "request.md"), "utf8")).resolves.toBe("  fix the bug  ");
      await expect(readFile(join(runRoot, "effective-config.yaml"), "utf8")).resolves.toContain(
        '"id": "bug"',
      );
      await expect(
        access(join(runRoot, "requirements", "requirement-v1.yaml")),
      ).resolves.toBeUndefined();
      for (const directory of [
        "analysis",
        "research",
        "decisions",
        "plans",
        "implementation",
        "verification/evidence",
        "reviews",
        "failures",
        "events",
        "runtime/repository",
        "runtime/executions",
        "runtime/staging",
        "runtime/debug",
      ]) {
        await expect(access(join(runRoot, directory))).resolves.toBeUndefined();
      }

      const events = await new JsonlEventReader(repositoryRoot).readAfter("run-001" as RunId, 0);
      expect(events.map(({ type }) => type)).toEqual([
        "run.created",
        "request.received",
        "requirement.created",
        "playbook.selected",
        "run.started",
      ]);

      const second = await new StartWorkflowUseCase({
        runStore: stateStore,
        repository,
        orchestrator: {
          async run(runId) {
            return {
              kind: "idle" as const,
              state: await runReader.load(runId),
              iterations: 1,
              reason: "GRAPH_NO_PROGRESS" as const,
            };
          },
        },
        now: () => new Date(CREATED_AT),
      }).execute("feature", "second workflow");
      expect(second.run.run_id).toBe("run-002");
    });
  });
});
