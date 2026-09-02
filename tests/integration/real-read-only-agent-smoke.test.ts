import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { CORE_SKILL_IDS } from "../../src/agents/definitions.js";
import { createPiPackageSkillCatalog } from "../../src/adapters/pi/skill-catalog.js";
import { PiSubagentsAdapter } from "../../src/adapters/pi/pi-subagents-adapter.js";
import { normalizeStepResult } from "../../src/application/normalization/result-normalizer.js";
import type { AgentExecutionRequestV1 } from "../../src/contracts/execution/agent-execution.js";
import { createStep } from "../../src/domain/graph/step-graph.js";
import type { ExecutionId, RunId, StepId } from "../../src/domain/primitives/ids.js";
import type { WorkflowState } from "../../src/ports/run-reader.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const PROVIDER_EXTENSION = resolve(
  import.meta.dirname,
  "../fixtures/real-read-only-agent-provider.ts",
);
const TOOL_AUDIT_ENV = "PI_WORKFLOW_STORY_06_05_TOOL_AUDIT";
const SMOKE_MODEL = "workflow-smoke/fixed";
const RUN_ID = "run-605" as RunId;

const roleSkills = {
  scout: "how",
  planner: "architect",
  researcher: "interrogate",
  oracle: "architect",
} as const satisfies Readonly<Record<"scout" | "planner" | "researcher" | "oracle", string>>;

const roleStepTypes = {
  scout: "analysis",
  planner: "planning",
  researcher: "research",
  oracle: "decision",
} as const;

type SmokeRole = keyof typeof roleSkills;

type Harness = {
  cwd: string;
  auditPath: string;
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  adapter: PiSubagentsAdapter;
  catalog: ReturnType<typeof createPiPackageSkillCatalog>;
  close: () => Promise<void>;
};

async function createHarness(): Promise<Harness> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-story-06-05-"));
  const agentDir = join(cwd, "agent");
  const projectConfigDir = join(cwd, ".pi");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  await Promise.all([
    writeFile(
      join(projectConfigDir, "settings.json"),
      JSON.stringify({ packages: [PROJECT_ROOT] }),
      "utf8",
    ),
    writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        subagents: {
          agentOverrides: Object.fromEntries(
            Object.keys(roleSkills).map((agent) => [agent, { extensions: [PROVIDER_EXTENSION] }]),
          ),
        },
      }),
      "utf8",
    ),
  ]);

  const auditPath = join(cwd, "tool-audit.json");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  const previousAuditPath = process.env[TOOL_AUDIT_ENV];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  process.env[TOOL_AUDIT_ENV] = auditPath;

  try {
    const eventBus = createEventBus();
    const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
    settingsManager.setProjectPackages([PROJECT_ROOT]);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      eventBus,
    });
    await resourceLoader.reload();

    const catalog = createPiPackageSkillCatalog(resourceLoader);
    const faux = fauxProvider({
      provider: "workflow-smoke",
      models: [{ id: "fixed", input: ["text"], reasoning: false }],
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const sessionResult = await createAgentSession({
      cwd,
      agentDir,
      model: faux.getModel(),
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    });
    await sessionResult.session.bindExtensions({ mode: "json" });

    const restore = (): void => {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
      if (previousAuditPath === undefined) delete process.env[TOOL_AUDIT_ENV];
      else process.env[TOOL_AUDIT_ENV] = previousAuditPath;
    };

    return {
      cwd,
      auditPath,
      session: sessionResult.session,
      adapter: new PiSubagentsAdapter(
        { events: eventBus },
        { cwd, sessionId: sessionResult.session.sessionManager.getSessionId() },
      ),
      catalog,
      close: async () => {
        sessionResult.session.dispose();
        restore();
        await rm(cwd, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    if (previousAuditPath === undefined) delete process.env[TOOL_AUDIT_ENV];
    else process.env[TOOL_AUDIT_ENV] = previousAuditPath;
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

function request(
  agentId: SmokeRole,
  stepId: StepId,
  executionId: ExecutionId,
  objective: string,
  repositoryTarget: string,
  skillId: string,
): AgentExecutionRequestV1 {
  return {
    identity: {
      runId: RUN_ID,
      stepId,
      executionId,
      agentId,
      agentVersion: "1.0.0",
    },
    objective: {
      objective,
      type: "story-06-05-smoke",
      completionCriteria: ["return a valid result"],
    },
    retry: { attempt: 1, context: null },
    execution: { mode: "read-only", timeoutMs: 30_000, cancellationPolicy: {} },
    authority: {
      maximumDLevel:
        agentId === "planner" ? "D1" : agentId === "oracle" ? "recommendation-only" : "D0",
      escalationRules: [],
    },
    permissions: {
      filesystem: ["repository"],
      shell: [],
      git: [],
      network: [],
      repositoryTargets: [repositoryTarget],
    },
    skills: { required: [{ id: skillId, version: "1.0.0" }], optional: [] },
    tools: {
      resolved: ["read", "grep", "find", "ls"],
      policy: { allow: ["read", "grep", "find", "ls"] },
    },
    model: {
      requested: SMOKE_MODEL,
      actual: SMOKE_MODEL,
      thinkingLevel: "low",
      allowedFallback: [],
    },
    context: { pack: {}, manifest: {}, artifactRefs: [] },
    outputs: { expectedArtifactTypes: [], outputContract: {} },
  };
}

function state(): WorkflowState {
  return {
    run: { run_id: RUN_ID },
    snapshot: {
      requirement: { acceptance_criteria: [], constraints: [] },
      uncertainties: { uncertainties: [] },
      decisions: { decisions: [] },
      findings: { findings: [] },
    },
  } as unknown as WorkflowState;
}

function readOnlyStep(agentId: SmokeRole, stepId: StepId, objective: string) {
  return createStep({
    id: stepId,
    type: roleStepTypes[agentId],
    objective,
    agent: agentId,
    status: "running",
  });
}

describe("real read-only Agent smoke tests", () => {
  it("normalizes real Scout, Planner, Researcher, and Oracle output with package Skills", async () => {
    const harness = await createHarness();
    try {
      const packageSkills = harness.catalog.list();
      expect(packageSkills).toHaveLength(CORE_SKILL_IDS.length);
      expect(packageSkills.map(({ id }) => id)).toEqual(
        expect.arrayContaining([...CORE_SKILL_IDS]),
      );
      for (const agentId of ["scout", "planner", "researcher", "oracle"] as const) {
        const skillId = roleSkills[agentId];
        const resolved = harness.catalog.resolve(agentId, [{ id: skillId, version: "1.0.0" }]);
        expect(resolved).toHaveLength(1);
        expect(resolved[0]?.content).toContain(`# ${skillId}`);
      }

      for (const [index, agentId] of (
        ["scout", "planner", "researcher", "oracle"] as const
      ).entries()) {
        const stepId = `step-${String(index + 1).padStart(3, "0")}` as StepId;
        const executionId = `exec-${String(index + 1).padStart(3, "0")}` as ExecutionId;
        const input = request(
          agentId,
          stepId,
          executionId,
          `smoke-${agentId}`,
          "src",
          roleSkills[agentId],
        );
        const result = await harness.adapter.run(input);
        const normalized = await normalizeStepResult({
          result,
          request: input,
          state: state(),
          step: readOnlyStep(agentId, stepId, input.objective.objective),
        });

        expect(normalized.result).toMatchObject({
          identity: {
            runId: input.identity.runId,
            stepId: input.identity.stepId,
            executionId: input.identity.executionId,
          },
          outcome: "completed",
          mode: "read-only",
          runtime: { recoveryAttempt: 1 },
        });
      }

      const sentinel = join(harness.cwd, "sentinel.txt");
      await writeFile(sentinel, "unchanged", "utf8");
      const permissionInput = request(
        "scout",
        "step-005" as StepId,
        "exec-005" as ExecutionId,
        "read-only-permission-check",
        sentinel,
        roleSkills.scout,
      );
      const permissionResult = await harness.adapter.run(permissionInput);
      expect(await readFile(sentinel, "utf8")).toBe("unchanged");
      expect(permissionResult.outcome).toBe("completed");

      const schemaInput = request(
        "scout",
        "step-006" as StepId,
        "exec-006" as ExecutionId,
        "schema-recovery",
        "src",
        roleSkills.scout,
      );
      const recovered = await harness.adapter.run(schemaInput);
      expect(recovered.runtime).toMatchObject({ recoveryAttempt: 2 });

      const auditedTools = JSON.parse(await readFile(harness.auditPath, "utf8")) as string[];
      expect(auditedTools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
      expect(auditedTools).not.toEqual(expect.arrayContaining(["bash", "edit", "write"]));

      expect(existsSync(join(harness.cwd, ".pi", "agent", "skills"))).toBe(false);
    } finally {
      await harness.close();
    }
  }, 120_000);
});
