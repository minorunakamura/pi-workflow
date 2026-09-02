import { describe, expect, it } from "vitest";
import { createIdAllocator, type RunId } from "../../src/domain/primitives/ids.js";
import {
  CancelWorkflowUseCase,
  ResumeWorkflowUseCase,
  StartWorkflowUseCase,
  StatusWorkflowUseCase,
  createInitialWorkflowState,
} from "../../src/application/workflow-use-cases.js";
import { PLAYBOOK_IDS } from "../../src/playbooks/definitions.js";
import type { RepositorySnapshot } from "../../src/ports/repository.js";
import type { RunReader, WorkflowState } from "../../src/ports/run-reader.js";
import type {
  RunStore,
  StateStoreCommitInput,
  StateStoreCreateInput,
} from "../../src/ports/state-store.js";
import type { CancellationRequestOptions } from "../../src/application/recovery/cancellation-lifecycle.js";

const CREATED_AT = "2026-08-30T03:02:10.123Z";
const repository: RepositorySnapshot = {
  root: "/repository",
  head: "abc123",
  branch: "main",
  status: { dirty: false, changed: [], untracked: [], entries: [] },
  fingerprints: {},
  fingerprint: "repository-fingerprint",
};

function fakeStore(): Readonly<{
  store: RunStore;
  get(): WorkflowState | undefined;
  creations: StateStoreCreateInput[];
  commits: StateStoreCommitInput[];
}> {
  let current: WorkflowState | undefined;
  const creations: StateStoreCreateInput[] = [];
  const commits: StateStoreCommitInput[] = [];
  const runIds = createIdAllocator();
  const store: RunStore = {
    async issueRunId() {
      return runIds.issueRunId();
    },
    async create(input) {
      creations.push(input);
      current = input.initial;
      return current;
    },
    async load(runId) {
      if (current?.run.run_id !== runId) throw new Error(`Unknown Run ${runId}`);
      return current;
    },
    async commit(input) {
      commits.push(input);
      current = input.next;
      return current;
    },
  };
  return { store, get: () => current, creations, commits };
}

function orchestrator(store: Readonly<{ get(): WorkflowState | undefined }>): {
  calls: RunId[];
  run: (runId: RunId) => Promise<{
    kind: "idle";
    state: WorkflowState;
    iterations: number;
    reason: "GRAPH_NO_PROGRESS";
  }>;
} {
  const calls: RunId[] = [];
  return {
    calls,
    async run(runId) {
      calls.push(runId);
      const state = store.get();
      if (state === undefined) throw new Error("Orchestrator started before Run creation");
      return { kind: "idle", state, iterations: 1, reason: "GRAPH_NO_PROGRESS" };
    },
  };
}

describe("production workflow use cases", () => {
  it("creates a valid initial graph for each of the six Playbooks and starts the Orchestrator", async () => {
    const store = fakeStore();
    const runner = orchestrator(store);
    const start = new StartWorkflowUseCase({
      runStore: store.store,
      repository: { captureSnapshot: async () => repository } as never,
      orchestrator: runner,
      idAllocator: createIdAllocator(),
      now: () => new Date(CREATED_AT),
    });

    for (const command of PLAYBOOK_IDS) {
      const state = await start.execute(command, `${command} request`);
      expect(state.run).toMatchObject({
        status: "running",
        finalized: false,
        request: { type: command },
        playbook: { initial: { id: command }, current: { id: command } },
      });
      expect(state.snapshot.steps.steps.length).toBeGreaterThan(0);
      expect(state.snapshot.steps.steps[0]?.status).toBe("ready");
      expect(store.creations.at(-1)?.initial.run.status).toBe("created");
      expect(store.commits.at(-1)?.next.run.status).toBe("running");
    }

    expect(runner.calls).toEqual([
      "run-001",
      "run-002",
      "run-003",
      "run-004",
      "run-005",
      "run-006",
    ]);
  });

  it("rejects an empty request before repository or Run Store access", async () => {
    const store = fakeStore();
    let repositoryCalls = 0;
    const start = new StartWorkflowUseCase({
      runStore: store.store,
      repository: {
        async captureSnapshot() {
          repositoryCalls += 1;
          return repository;
        },
      } as never,
      orchestrator: orchestrator(store),
    });

    await expect(start.execute("feature", "  ")).rejects.toThrow(
      "Workflow request must be non-empty",
    );
    expect(repositoryCalls).toBe(0);
    expect(store.creations).toHaveLength(0);
  });

  it("keeps status read-only and resumes/cancels through their lifecycle boundaries", async () => {
    const state = createInitialWorkflowState({
      runId: "run-001" as RunId,
      command: "feature",
      goal: "request",
      repository,
      idAllocator: createIdAllocator(),
      createdAt: CREATED_AT,
    });
    const reader: RunReader = {
      async load() {
        return state;
      },
    };
    const status = new StatusWorkflowUseCase({ runReader: reader });
    await expect(status.execute("run-001" as RunId)).resolves.toBe(state);

    const lifecycleCalls: string[] = [];
    const resumedState = { ...state, run: { ...state.run, status: "running" as const } };
    const resume = new ResumeWorkflowUseCase({
      lifecycle: {
        async resume(runId) {
          lifecycleCalls.push(`resume:${runId}`);
          return resumedState;
        },
      },
      orchestrator: {
        async run(runId) {
          lifecycleCalls.push(`orchestrator:${runId}`);
          return { kind: "idle", state: resumedState, iterations: 1, reason: "GRAPH_NO_PROGRESS" };
        },
      },
    });
    await expect(resume.execute("run-001" as RunId)).resolves.toBe(resumedState);

    let cancellationOptions: CancellationRequestOptions | undefined;
    const cancelledState = {
      ...state,
      run: { ...state.run, status: "cancelled" as const, finalized: true },
    };
    const cancel = new CancelWorkflowUseCase({
      lifecycle: {
        async cancel(runId, options) {
          lifecycleCalls.push(`cancel:${runId}`);
          cancellationOptions = options;
          return cancelledState;
        },
      },
    });
    const options = { requestedBy: "user", reason: "stop" };
    await expect(cancel.execute("run-001" as RunId, options)).resolves.toBe(cancelledState);
    expect(lifecycleCalls).toEqual(["resume:run-001", "orchestrator:run-001", "cancel:run-001"]);
    expect(cancellationOptions).toEqual(options);
  });
});
