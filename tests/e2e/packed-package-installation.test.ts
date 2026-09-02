import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import { describe, expect, it } from "vitest";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { CORE_SKILL_IDS } from "../../src/agents/definitions.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import { WORKFLOW_COMMANDS } from "../../src/extensions/commands/register-workflow-commands.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function pnpmInvocation(args: readonly string[]): { command: string; args: string[] } {
  return process.platform === "win32"
    ? {
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", PNPM, ...args],
      }
    : { command: PNPM, args: [...args] };
}

type CommandOutput = Readonly<{
  stdout: string;
  stderr: string;
}>;

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<CommandOutput> {
  const invocation = command === PNPM ? pnpmInvocation(args) : { command, args: [...args] };
  const result = await execFileAsync(invocation.command, invocation.args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

function completedStepResult(request: SubagentDelegationRequest): Record<string, unknown> {
  return {
    identity: {
      runId: request.ownerRunId,
      stepId: request.nodeId,
      executionId: request.requestId,
    },
    outcome: "completed",
    summary: `completed:${request.agent}`,
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: { acceptance_criteria: [], constraints: [], assumptions: [] },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks:
      request.agent === "verifier"
        ? [{ type: "test", status: "passed", required: true, evidence: { exit_code: 0 } }]
        : [],
    observations: [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

function testUi(notifications: string[]): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message: string) => notifications.push(message),
  } as unknown as ExtensionUIContext;
}

describe("packed Pi Package installation", () => {
  it("loads the artifact in a clean consumer and runs the default /wf-* path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-workflow story-13-03-日本語-"));
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

    try {
      const artifactDirectory = join(tempRoot, "artifact");
      await mkdir(artifactDirectory);
      const pack = await runCommand(
        PNPM,
        ["pack", "--pack-destination", artifactDirectory],
        PROJECT_ROOT,
      );
      const artifacts = (await readdir(artifactDirectory)).filter((file) => file.endsWith(".tgz"));
      expect(artifacts).toHaveLength(1);
      const artifactPath = join(artifactDirectory, artifacts[0]!);
      const evidenceDirectory = process.env.PI_WORKFLOW_EVIDENCE_DIR;
      if (evidenceDirectory !== undefined) {
        await mkdir(evidenceDirectory, { recursive: true });
        await copyFile(artifactPath, join(evidenceDirectory, "pi-workflow.tgz"));
        await writeFile(
          join(evidenceDirectory, "pnpm-pack.log"),
          `${pack.stdout}\n${pack.stderr}`,
          "utf8",
        );
      }

      const consumerRoot = join(tempRoot, "consumer");
      await mkdir(consumerRoot);
      await Promise.all([
        writeFile(
          join(consumerRoot, "package.json"),
          JSON.stringify(
            { name: "pi-workflow-clean-consumer", private: true, version: "1.0.0" },
            null,
            2,
          ) + "\n",
          "utf8",
        ),
        writeFile(
          join(consumerRoot, ".gitignore"),
          "node_modules/\n.pi/\nagent/\nrelease-evidence/\n",
          "utf8",
        ),
        writeFile(join(consumerRoot, "README.md"), "# clean consumer\n", "utf8"),
      ]);

      const install = await runCommand(
        PNPM,
        ["add", "--ignore-workspace", "--ignore-scripts", artifactPath],
        consumerRoot,
      );
      if (evidenceDirectory !== undefined) {
        await writeFile(
          join(evidenceDirectory, "pnpm-install.log"),
          `${install.stdout}\n${install.stderr}`,
          "utf8",
        );
      }
      const packageRoot = await realpath(join(consumerRoot, "node_modules", "pi-workflow"));
      expect(packageRoot).not.toBe(PROJECT_ROOT);
      expect(packageRoot).toContain(join("node_modules", "pi-workflow"));

      await runCommand("git", ["init", "--quiet"], consumerRoot);
      await runCommand("git", ["config", "user.email", "test@example.com"], consumerRoot);
      await runCommand("git", ["config", "user.name", "Pi Workflow Test"], consumerRoot);
      await runCommand("git", ["config", "commit.gpgSign", "false"], consumerRoot);
      await runCommand("git", ["add", "--all"], consumerRoot);
      await runCommand("git", ["commit", "--quiet", "-m", "clean consumer baseline"], consumerRoot);
      await runCommand("git", ["branch", "-M", "main"], consumerRoot);
      expect((await runCommand("git", ["status", "--porcelain"], consumerRoot)).stdout).toBe("");

      const packageManifest = JSON.parse(
        await readFile(join(packageRoot, "package.json"), "utf8"),
      ) as {
        pi?: { extensions?: unknown[]; skills?: unknown[] };
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        bundledDependencies?: string[];
      };
      expect(packageManifest.pi?.extensions).toEqual(
        expect.arrayContaining([
          "./src/extensions/workflow.ts",
          "./node_modules/pi-subagents/index.ts",
        ]),
      );
      expect(packageManifest.pi?.skills).toEqual(["./skills"]);
      expect(packageManifest.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
      expect(packageManifest.dependencies?.["@earendil-works/pi-coding-agent"]).toBeUndefined();
      expect(packageManifest.dependencies?.["pi-subagents"]).toBeDefined();
      expect(packageManifest.bundledDependencies).toContain("pi-subagents");
      expect(existsSync(join(packageRoot, "node_modules", "pi-subagents", "package.json"))).toBe(
        true,
      );
      expect(
        existsSync(join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent")),
      ).toBe(false);

      const installedPackageJson = JSON.parse(
        await readFile(join(consumerRoot, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      expect(installedPackageJson.dependencies?.["pi-workflow"]).toContain(".tgz");
      expect(existsSync(join(consumerRoot, ".pi", "agent", "skills"))).toBe(false);
      expect(existsSync(join(packageRoot, ".pi", "agent", "skills"))).toBe(false);

      const eventBus = createEventBus();
      const requests: SubagentDelegationRequest[] = [];
      eventBus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        const request = payload as SubagentDelegationRequest;
        requests.push(request);
        eventBus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          result: { kind: "structured", value: completedStepResult(request) },
        } satisfies SubagentDelegationResponse);
      });

      await mkdir(join(consumerRoot, "agent"), { recursive: true });
      const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
      settingsManager.setProjectPackages([packageRoot]);
      const resourceLoader = new DefaultResourceLoader({
        cwd: consumerRoot,
        agentDir: join(consumerRoot, "agent"),
        settingsManager,
        eventBus,
      });
      await resourceLoader.reload();

      const loadedSkills = resourceLoader.getSkills();
      expect(loadedSkills.diagnostics.filter(({ type }) => type === "error")).toEqual([]);
      expect(loadedSkills.skills.map(({ name }) => name).sort()).toEqual(
        [...CORE_SKILL_IDS].sort(),
      );
      expect(loadedSkills.skills).toHaveLength(9);
      expect(loadedSkills.skills.every(({ sourceInfo }) => sourceInfo.origin === "package")).toBe(
        true,
      );
      expect(
        loadedSkills.skills.every(({ filePath }) =>
          filePath.startsWith(join(packageRoot, "skills")),
        ),
      ).toBe(true);
      for (const skill of loadedSkills.skills) {
        const content = await readFile(skill.filePath, "utf8");
        expect(content).toContain("## Procedure");
        expect(content).not.toMatch(
          /will be added|will be implemented|\bTODO\b|\bplaceholder\b|not implemented|\bTBD\b/i,
        );
      }

      const extensions = resourceLoader.getExtensions();
      expect(extensions.errors).toEqual([]);
      const workflowExtension = extensions.extensions.find(
        (extension) => extension.path === resolve(packageRoot, "src", "extensions", "workflow.ts"),
      );
      expect(workflowExtension).toBeDefined();
      expect(workflowExtension?.sourceInfo.origin).toBe("package");
      expect([...workflowExtension!.commands.keys()]).toEqual(
        WORKFLOW_COMMANDS.map(({ name }) => name),
      );
      expect(
        extensions.extensions.some(
          (extension) =>
            extension.path === resolve(packageRoot, "node_modules", "pi-subagents", "index.ts"),
        ),
      ).toBe(true);

      const faux = fauxProvider({
        provider: "pi-workflow-story-13-03",
        models: [{ id: "smoke", input: ["text"], reasoning: false }],
      });
      const sessionResult = await createAgentSession({
        cwd: consumerRoot,
        agentDir: join(consumerRoot, "agent"),
        model: faux.getModel(),
        resourceLoader,
        sessionManager: SessionManager.inMemory(consumerRoot),
        settingsManager,
      });
      session = sessionResult.session;
      const notifications: string[] = [];
      await session.bindExtensions({ mode: "json", uiContext: testUi(notifications) });
      await session.prompt("/wf-feature packed package smoke");

      const state = await new FileRunReader(consumerRoot).load("run-001" as RunId);
      expect(state.run).toMatchObject({ status: "completed", finalized: true });
      expect(notifications.join("\n")).not.toContain("NOT_IMPLEMENTED");
      expect(requests.map(({ agent }) => agent)).toEqual([
        "scout",
        "planner",
        "worker",
        "verifier",
        "reviewer",
      ]);
      const scoutRequest = requests[0];
      expect(scoutRequest?.skill).toEqual(["how", "why", "blast-radius"]);
      expect(scoutRequest?.task).toContain(
        "Resolved Workflow Prompt (assembled from the selected Skill content and execution inputs):",
      );
      expect(scoutRequest?.task).toContain("Selected Skill how@1.0.0");
      expect(scoutRequest?.task).toContain("## Procedure");
      expect(scoutRequest?.task).not.toContain("Selected Skill architect@1.0.0");
      expect(new Set(requests.map(({ cwd }) => cwd))).toEqual(
        new Set([await realpath(consumerRoot)]),
      );
      expect((await runCommand("git", ["status", "--porcelain"], consumerRoot)).stdout).toBe("");

      const consumerEvidenceDirectory = join(consumerRoot, "release-evidence");
      await mkdir(consumerEvidenceDirectory, { recursive: true });
      const packLogPath = join(consumerEvidenceDirectory, "pnpm-pack.log");
      const installLogPath = join(consumerEvidenceDirectory, "pnpm-install.log");
      await writeFile(packLogPath, `${pack.stdout}\n${pack.stderr}`, "utf8");
      await writeFile(installLogPath, `${install.stdout}\n${install.stderr}`, "utf8");
      const evidencePath = join(consumerEvidenceDirectory, "story-13-03.json");
      const evidence = {
        OS: process.platform,
        "Node version": process.version,
        "pnpm version": (await runCommand(PNPM, ["--version"], PROJECT_ROOT)).stdout.trim(),
        "Git version": (await runCommand("git", ["--version"], consumerRoot)).stdout.trim(),
        "filesystem/environment": {
          consumerRoot,
          packageRoot,
          authoredSkillCopy: false,
        },
        "test command": "pnpm test tests/e2e/packed-package-installation.test.ts",
        result: "PASS",
        "artifact/log location": {
          artifact: artifactPath,
          packLog: packLogPath,
          installLog: installLogPath,
          evidence: evidencePath,
        },
      };
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
      const recordedEvidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
        result?: string;
        [key: string]: unknown;
      };
      expect(recordedEvidence.result).toBe("PASS");
      expect(recordedEvidence["artifact/log location"]).toEqual(evidence["artifact/log location"]);
    } finally {
      session?.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
