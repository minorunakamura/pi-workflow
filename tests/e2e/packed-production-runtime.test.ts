import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  SUBAGENT_DELEGATION_STARTED_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FileArtifactStore } from "../../src/adapters/persistence/write/file-artifact-store.js";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import { CORE_SKILL_IDS } from "../../src/agents/definitions.js";
import type { RunId } from "../../src/domain/primitives/ids.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PNPM = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const AGENT_IDS = ["scout", "researcher", "planner", "oracle", "worker", "verifier", "reviewer"];
const PROVIDER_ID = "pi-workflow-story-13-09";
const MODEL_ID = "packed";
const AUDIT_ENV = "PI_WORKFLOW_STORY_13_09_AUDIT";
const DELAY_ENV = "PI_WORKFLOW_STORY_13_09_DELAY_URL";

type CommandOutput = Readonly<{ stdout: string; stderr: string }>;

type ProviderImport = Readonly<{
  importPath: string;
  auditPath: string;
}>;

function pnpmInvocation(args: readonly string[]): { command: string; args: string[] } {
  return process.platform === "win32"
    ? {
        command: process.env.ComSpec ?? "cmd.exe",
        args: ["/d", "/s", "/c", PNPM, ...args],
      }
    : { command: PNPM, args: [...args] };
}

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

async function initializeGit(root: string): Promise<void> {
  await runCommand("git", ["init", "--quiet"], root);
  await runCommand("git", ["config", "user.email", "test@example.com"], root);
  await runCommand("git", ["config", "user.name", "Pi Workflow Test"], root);
  await runCommand("git", ["config", "commit.gpgSign", "false"], root);
  await runCommand("git", ["add", "--all"], root);
  await runCommand("git", ["commit", "--quiet", "-m", "clean consumer baseline"], root);
  await runCommand("git", ["branch", "-M", "main"], root);
}

function providerSource({ importPath, auditPath }: ProviderImport): string {
  return `import { appendFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(importPath)};

const provider = fauxProvider({
  api: "${PROVIDER_ID}",
  provider: "${PROVIDER_ID}",
  models: [{
    id: "${MODEL_ID}",
    input: ["text"],
    reasoning: false,
    contextWindow: 32_000,
    maxTokens: 4_096,
  }],
});
const auditPath = ${JSON.stringify(auditPath)};

type PackedRequest = {
  identity: { runId: string; stepId: string; executionId: string; agentId: string };
  objective: { objective: string };
  execution: { mode: string };
};

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\\n");
}

function latestUserText(context: { messages: readonly unknown[] }): string {
  for (const message of [...context.messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    const value = message as { role?: unknown; content?: unknown };
    if (value.role === "user") return textContent(value.content);
  }
  return "";
}

function requestFrom(context: { messages: readonly unknown[] }): PackedRequest {
  for (const message of [...context.messages].reverse()) {
    if (!message || typeof message !== "object") continue;
    const value = message as { role?: unknown; content?: unknown };
    if (value.role !== "user") continue;
    const text = textContent(value.content);
    const marker = "Execution request (JSON):";
    const start = text.indexOf(marker);
    if (start < 0) continue;
    const payload = text.slice(start + marker.length).trimStart();
    const end = payload.indexOf("\\n\\nReturn only");
    if (end < 0) continue;
    return JSON.parse(payload.slice(0, end)) as PackedRequest;
  }
  throw new Error("Packed provider could not find an Agent Execution request");
}

function resultFor(request: PackedRequest): Record<string, unknown> {
  const verifier = request.identity.agentId === "verifier";
  const planner = request.identity.agentId === "planner";
  return {
    identity: {
      runId: request.identity.runId,
      stepId: request.identity.stepId,
      executionId: request.identity.executionId,
    },
    outcome: "completed",
    mode: request.execution.mode,
    summary: "packed production bridge result",
    artifacts: [],
    uncertainty_candidates: [],
    decision_requests: [],
    requirement_candidates: { acceptance_criteria: [], constraints: [], assumptions: [] },
    finding_candidates: [],
    finding_rechecks: [],
    plan_deviations: [],
    skill_requests: [],
    execution_checks: verifier
      ? [{ type: "test", status: "passed", required: true, evidence: { exit_code: 0 } }]
      : [],
    observations: planner ? [{ write_scope: ["src"] }] : [],
    blocked: null,
    failure: null,
    runtime: {},
  };
}

function response(
  context: { messages: readonly unknown[] },
  _options: unknown,
  state: { callCount: number },
) {
  const request = requestFrom(context);
  appendFileSync(
    auditPath,
    JSON.stringify({
      agent: request.identity.agentId,
      call: state.callCount,
      task: latestUserText(context),
      systemPrompt:
        typeof (context as { systemPrompt?: unknown }).systemPrompt === "string"
          ? (context as { systemPrompt: string }).systemPrompt
          : "",
      request,
    }) + "\\n",
    "utf8",
  );
  if (request.identity.agentId === "worker" && state.callCount === 1) {
    return fauxAssistantMessage(
      fauxToolCall("edit", {
        path: "src/packed-runtime.txt",
        edits: [{ oldText: "baseline\\n", newText: "packed production runtime\\n" }],
      }),
    );
  }
  return fauxAssistantMessage(fauxToolCall("structured_output", { value: resultFor(request) }));
}

let delayConsumed = false;

async function delayedResponse(
  context: { messages: readonly unknown[] },
  options: unknown,
  state: { callCount: number },
) {
  const request = requestFrom(context);
  const delayUrl = process.env["PI_WORKFLOW_STORY_13_09_DELAY_URL"];
  if (delayUrl && !delayConsumed && request.identity.agentId === "scout") {
    delayConsumed = true;
    const gate = await fetch(delayUrl + "/scout");
    if (!gate.ok) throw new Error("lifecycle gate failed: " + gate.status);
  }
  return response(context, options, state);
}

provider.setResponses([delayedResponse, delayedResponse]);

export default function registerPackedProvider(pi: { registerProvider(provider: unknown): void }): void {
  pi.registerProvider(provider.provider);
}
`;
}

function testUi(notifications: string[]): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: (message: string) => notifications.push(message),
    setToolsExpanded: () => {},
  } as unknown as ExtensionUIContext;
}

describe("packed Pi Package production Agent runtime", () => {
  it("waits for a delayed Scout before completing the installed real Pi bridge path", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-workflow story-13-09-日本語-"));
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousOffline = process.env.PI_OFFLINE;
    const previousAuditPath = process.env[AUDIT_ENV];
    const previousDelayUrl = process.env[DELAY_ENV];
    let delayServer: ReturnType<typeof createServer> | undefined;
    let releaseScout: (() => void) | undefined;

    try {
      const artifactDirectory = join(tempRoot, "artifact");
      await mkdir(artifactDirectory, { recursive: true });
      const pack = await runCommand(
        PNPM,
        ["pack", "--pack-destination", artifactDirectory],
        PROJECT_ROOT,
      );
      const artifacts = (await readdir(artifactDirectory)).filter((file) => file.endsWith(".tgz"));
      expect(artifacts).toHaveLength(1);
      const artifactPath = join(artifactDirectory, artifacts[0]!);

      const consumerRoot = join(tempRoot, "consumer");
      const sourceRoot = join(consumerRoot, "src");
      const agentDir = join(consumerRoot, "agent");
      const projectConfigDir = join(consumerRoot, ".pi");
      const providerPath = join(consumerRoot, "packed-provider.ts");
      const auditPath = join(consumerRoot, "packed-provider-audit.jsonl");
      await mkdir(consumerRoot, { recursive: true });
      await Promise.all([
        mkdir(sourceRoot, { recursive: true }),
        mkdir(agentDir, { recursive: true }),
        mkdir(projectConfigDir, { recursive: true }),
        writeFile(
          join(consumerRoot, "package.json"),
          JSON.stringify(
            { name: "pi-workflow-story-13-09-consumer", private: true, version: "1.0.0" },
            null,
            2,
          ) + "\n",
          "utf8",
        ),
        writeFile(
          join(consumerRoot, ".gitignore"),
          "node_modules/\n.pi/\nagent/\nrelease-evidence/\npacked-provider-audit.jsonl\n",
          "utf8",
        ),
        writeFile(
          join(consumerRoot, "README.md"),
          "# packed production runtime consumer\n",
          "utf8",
        ),
        writeFile(join(sourceRoot, "packed-runtime.txt"), "baseline\n", "utf8"),
        writeFile(
          providerPath,
          providerSource({
            importPath: pathToFileURL(
              resolve(PROJECT_ROOT, "node_modules/@earendil-works/pi-ai/dist/providers/faux.js"),
            ).href,
            auditPath,
          }),
          "utf8",
        ),
        writeFile(
          join(projectConfigDir, "settings.json"),
          JSON.stringify({ packages: [] }, null, 2) + "\n",
          "utf8",
        ),
      ]);
      const install = await runCommand(
        PNPM,
        ["add", "--ignore-workspace", "--ignore-scripts", artifactPath],
        consumerRoot,
      );
      await initializeGit(consumerRoot);
      const packageRoot = await realpath(join(consumerRoot, "node_modules", "pi-workflow"));
      await writeFile(
        join(projectConfigDir, "settings.json"),
        JSON.stringify({ packages: [packageRoot] }, null, 2) + "\n",
        "utf8",
      );
      expect(packageRoot).not.toBe(PROJECT_ROOT);
      expect(packageRoot).toContain(join("node_modules", "pi-workflow"));

      const packageManifest = JSON.parse(
        await readFile(join(packageRoot, "package.json"), "utf8"),
      ) as {
        pi?: { extensions?: unknown[]; skills?: unknown[]; subagents?: { agents?: unknown[] } };
      };
      expect(packageManifest.pi?.subagents?.agents).toEqual(["./agents"]);
      for (const agentId of AGENT_IDS) {
        expect(existsSync(join(packageRoot, "agents", `${agentId}.md`))).toBe(true);
      }
      expect(existsSync(join(consumerRoot, ".pi", "agent", "skills"))).toBe(false);
      expect(existsSync(join(consumerRoot, ".pi", "agents"))).toBe(false);
      expect(existsSync(join(agentDir, "agents"))).toBe(false);
      expect(existsSync(join(packageRoot, ".pi", "agent", "skills"))).toBe(false);

      const agentOverrides = Object.fromEntries(
        AGENT_IDS.map((agentId) => [agentId, { extensions: [providerPath] }]),
      );
      await writeFile(
        join(agentDir, "settings.json"),
        JSON.stringify({ subagents: { agentOverrides } }, null, 2) + "\n",
        "utf8",
      );

      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_OFFLINE = "1";
      process.env[AUDIT_ENV] = auditPath;

      let scoutReachedResolve!: () => void;
      const scoutReached = new Promise<void>((resolve) => {
        scoutReachedResolve = resolve;
      });
      delayServer = createServer((request, response) => {
        if (request.url !== "/scout") {
          response.writeHead(404).end();
          return;
        }
        if (releaseScout !== undefined) {
          response.end("already released");
          return;
        }
        scoutReachedResolve();
        releaseScout = () => {
          response.end("release");
          releaseScout = undefined;
        };
      });
      await new Promise<void>((resolveListen, reject) => {
        delayServer!.once("error", reject);
        delayServer!.listen(0, "127.0.0.1", resolveListen);
      });
      const address = delayServer.address();
      if (address === null || typeof address === "string") {
        throw new Error("Lifecycle test gate did not expose a TCP address");
      }
      process.env[DELAY_ENV] = `http://127.0.0.1:${address.port}`;

      const eventBus = createEventBus();
      const requests: SubagentDelegationRequest[] = [];
      const responses: SubagentDelegationResponse[] = [];
      let childStartedResolve!: () => void;
      const childStarted = new Promise<void>((resolve) => {
        childStartedResolve = resolve;
      });
      eventBus.on(SUBAGENT_DELEGATION_STARTED_EVENT, (payload) => {
        if ((payload as { nodeId?: unknown }).nodeId === "step-001") childStartedResolve();
      });
      eventBus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (payload) => {
        requests.push(payload as SubagentDelegationRequest);
      });
      eventBus.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload) => {
        responses.push(payload as SubagentDelegationResponse);
      });

      const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
      settingsManager.setProjectPackages([packageRoot]);
      const resourceLoader = new DefaultResourceLoader({
        cwd: consumerRoot,
        agentDir,
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
      expect(resourceLoader.getExtensions().errors).toEqual([]);

      const faux = fauxProvider({
        provider: PROVIDER_ID,
        models: [{ id: MODEL_ID, input: ["text"], reasoning: false }],
      });
      const sessionResult = await createAgentSession({
        cwd: consumerRoot,
        agentDir,
        model: faux.getModel(),
        resourceLoader,
        sessionManager: SessionManager.inMemory(consumerRoot),
        settingsManager,
      });
      session = sessionResult.session;
      const notifications: string[] = [];
      await session.bindExtensions({ mode: "json", uiContext: testUi(notifications) });
      let invocationSettled = false;
      const invocation = session.prompt("/wf-feature packed production runtime").then(() => {
        invocationSettled = true;
      });
      await childStarted;
      await scoutReached;
      await Promise.resolve();
      expect(invocationSettled).toBe(false);
      expect(responses).toHaveLength(0);
      await expect(new FileRunReader(consumerRoot).load("run-001" as RunId)).resolves.toMatchObject(
        {
          run: { status: "running", finalized: false, state_revision: 2 },
        },
      );

      releaseScout!();
      await invocation;
      expect(invocationSettled).toBe(true);

      const state = await new FileRunReader(consumerRoot).load("run-001" as RunId);
      expect(state.run).toMatchObject({ status: "completed", finalized: true });
      expect(state.run.outcome).toMatchObject({
        status: "completed",
        request_satisfied: true,
        artifact_path: "outcome.md",
      });
      expect(await readFile(join(sourceRoot, "packed-runtime.txt"), "utf8")).toBe(
        "packed production runtime\n",
      );
      expect(requests.map(({ agent }) => agent)).toEqual([
        "scout",
        "planner",
        "worker",
        "verifier",
        "reviewer",
      ]);
      expect(responses).toHaveLength(requests.length);
      expect(
        responses.every(
          (response) =>
            response.status === "completed" &&
            "result" in response &&
            response.result?.kind === "structured",
        ),
      ).toBe(true);
      expect(new Set(requests.map(({ cwd }) => cwd))).toEqual(
        new Set([await realpath(consumerRoot)]),
      );
      expect(requests.find(({ agent }) => agent === "scout")?.skill).toEqual([
        "how",
        "why",
        "blast-radius",
      ]);
      const scoutTask = requests.find(({ agent }) => agent === "scout")?.task ?? "";
      expect(scoutTask).toContain("Selected Skill how@1.0.0");
      expect(scoutTask).toContain("## Procedure");
      expect(scoutTask).toContain("Agent candidate identity boundary:");
      expect(scoutTask).toContain("Do not include `id`, `authoritative_id`, or `state_id`");
      expect(scoutTask).toContain("Orchestrator normalization allocates authoritative identity");
      expect(scoutTask).toContain("authoritativeAllocation");
      expect(notifications.join("\n")).not.toContain("NOT_IMPLEMENTED");

      const audit = (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              agent: string;
              call: number;
              task: string;
              systemPrompt: string;
            },
        );
      expect(audit.map(({ agent }) => agent)).toEqual([
        "scout",
        "planner",
        "worker",
        "worker",
        "verifier",
        "reviewer",
      ]);
      expect(
        audit
          .filter(({ agent }) => agent === "scout")
          .every(
            ({ task }) =>
              task.includes("Resolved Workflow Prompt") && task.includes("## Procedure"),
          ),
      ).toBe(true);
      expect(audit.find(({ agent }) => agent === "verifier")?.systemPrompt).toContain(
        "You are the Workflow Verifier Agent.",
      );
      expect(audit.find(({ agent }) => agent === "reviewer")?.systemPrompt).toContain(
        "You are the Workflow Reviewer Agent.",
      );

      const steps = state.snapshot.steps.steps;
      expect(steps.find(({ agent }) => agent === "worker")?.result).toMatchObject({
        finalization: {
          kind: "change-set",
          change_set: { status: "complete", accepted: true },
        },
      });
      expect(steps.find(({ agent }) => agent === "verifier")?.result).toMatchObject({
        finalization: {
          kind: "verification-run",
          verification_run: { status: "complete", result: "passed", accepted: true },
        },
      });
      expect(steps.find(({ agent }) => agent === "reviewer")?.result).toMatchObject({
        finalization: {
          kind: "review-run",
          review_run: { status: "complete", result: "clean" },
        },
      });
      const artifactsStore = new FileArtifactStore(consumerRoot);
      await expect(
        artifactsStore.read({
          runId: "run-001" as RunId,
          path: "outcome.md",
          status: "complete",
        }),
      ).resolves.toMatchObject({ frontMatter: { artifact: { type: "outcome" } } });
      expect((await runCommand("git", ["status", "--porcelain"], consumerRoot)).stdout).toContain(
        " M src/packed-runtime.txt",
      );

      const evidenceDirectory = process.env.PI_WORKFLOW_EVIDENCE_DIR;
      if (evidenceDirectory !== undefined) {
        await mkdir(evidenceDirectory, { recursive: true });
        await writeFile(
          join(evidenceDirectory, "packed-production-runtime.json"),
          `${JSON.stringify(
            {
              OS: process.platform,
              "Node version": process.version,
              "pnpm version": (await runCommand(PNPM, ["--version"], PROJECT_ROOT)).stdout.trim(),
              "Git version": (await runCommand("git", ["--version"], consumerRoot)).stdout.trim(),
              "filesystem/environment": {
                consumerRoot,
                packageRoot,
                sourceCheckoutResourceRoot: false,
                authoredSkillCopy: false,
              },
              "test command": "pnpm test tests/e2e/packed-production-runtime.test.ts",
              result: "PASS",
              "artifact/log location": {
                artifact: artifactPath,
                pack: pack.stdout.trim(),
                install: install.stdout.trim(),
                providerAudit: auditPath,
              },
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      }
    } finally {
      releaseScout?.();
      session?.dispose();
      if (delayServer?.listening) {
        await new Promise<void>((resolveClose) => delayServer!.close(() => resolveClose()));
      }
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
      if (previousAuditPath === undefined) delete process.env[AUDIT_ENV];
      else process.env[AUDIT_ENV] = previousAuditPath;
      if (previousDelayUrl === undefined) delete process.env[DELAY_ENV];
      else process.env[DELAY_ENV] = previousDelayUrl;
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
