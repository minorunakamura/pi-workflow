import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { FileRunReader } from "../../src/adapters/persistence/read/file-run-reader.js";
import type { RunId } from "../../src/domain/primitives/ids.js";
import { withGoldenRepository } from "../fixtures/golden-repositories.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const PROVIDER_EXTENSION = resolve(
  import.meta.dirname,
  "../fixtures/production-security-agent-provider.ts",
);
const AGENT_IDS = ["scout", "researcher", "planner", "oracle", "worker", "verifier", "reviewer"];
const AUDIT_ENV = "PI_WORKFLOW_STORY_13_08_AUDIT";
const TARGET_ENV = "PI_WORKFLOW_STORY_13_08_TARGET";
const SENTINEL = "src/security-sentinel.txt";

function testUi(): ExtensionUIContext {
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => {},
    setToolsExpanded: () => {},
  } as unknown as ExtensionUIContext;
}

describe("STORY-13-08 production security composition", () => {
  it("enforces read-only/verify-only mutation and denied Tools at the real Pi bridge", async () => {
    await withGoldenRepository(
      "feature",
      {
        ".gitignore": ".pi/\nagent/\nsecurity-audit.jsonl\n",
        [SENTINEL]: "must remain unchanged\n",
      },
      async (repositoryRoot) => {
        const agentDir = join(repositoryRoot, "agent");
        const auditPath = join(repositoryRoot, "security-audit.jsonl");
        await mkdir(join(repositoryRoot, ".pi"), { recursive: true });
        await mkdir(agentDir, { recursive: true });
        await writeFile(
          join(repositoryRoot, ".pi", "settings.json"),
          JSON.stringify({ packages: [PROJECT_ROOT] }),
          "utf8",
        );
        await writeFile(
          join(agentDir, "settings.json"),
          JSON.stringify({
            subagents: {
              agentOverrides: Object.fromEntries(
                AGENT_IDS.map((agent) => [agent, { subagentOnlyExtensions: [PROVIDER_EXTENSION] }]),
              ),
            },
          }),
          "utf8",
        );

        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        const previousOffline = process.env.PI_OFFLINE;
        const previousAuditPath = process.env[AUDIT_ENV];
        const previousTarget = process.env[TARGET_ENV];
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

        try {
          process.env.PI_CODING_AGENT_DIR = agentDir;
          process.env.PI_OFFLINE = "1";
          process.env[AUDIT_ENV] = auditPath;
          process.env[TARGET_ENV] = SENTINEL;

          const eventBus = createEventBus();
          const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
          settingsManager.setProjectPackages([PROJECT_ROOT]);
          const resourceLoader = new DefaultResourceLoader({
            cwd: repositoryRoot,
            agentDir,
            settingsManager,
            eventBus,
          });
          await resourceLoader.reload();
          expect(resourceLoader.getExtensions().errors).toEqual([]);

          const faux = fauxProvider({
            provider: "pi-workflow-story-13-08",
            models: [{ id: "security", input: ["text"], reasoning: false }],
          });
          const sessionResult = await createAgentSession({
            cwd: repositoryRoot,
            agentDir,
            model: faux.getModel(),
            resourceLoader,
            sessionManager: SessionManager.inMemory(repositoryRoot),
            settingsManager,
          });
          session = sessionResult.session;

          // No delegation response listener is installed: pi-subagents is the concrete bridge.
          await session.bindExtensions({ mode: "json", uiContext: testUi() });
          await session.prompt("/wf-feature production security bridge");

          const productionState = await new FileRunReader(repositoryRoot).load("run-001" as RunId);
          expect(productionState.run).toMatchObject({
            status: "completed",
            finalized: true,
            outcome: { status: "completed", request_satisfied: true },
          });
          await expect(readFile(join(repositoryRoot, SENTINEL), "utf8")).resolves.toBe(
            "must remain unchanged\n",
          );
          await expect(readFile(join(repositoryRoot, "src/feature.txt"), "utf8")).resolves.toBe(
            "worker mutation\n",
          );

          const audits = (await readFile(auditPath, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  agent: string;
                  call: number;
                  mode: string;
                  advertisedTools: string[];
                  toolResults: Array<{ toolName: string; isError: boolean; text: string }>;
                },
            );
          const scoutRetry = audits.find(({ agent, call }) => agent === "scout" && call === 2);
          const workerInitial = audits.find(({ agent, call }) => agent === "worker" && call === 1);
          const verifierFinal = audits.find(
            ({ agent, call }) => agent === "verifier" && call === 3,
          );

          expect(workerInitial).toMatchObject({ mode: "write" });
          expect(workerInitial?.advertisedTools).toEqual(expect.arrayContaining(["edit", "write"]));

          expect(scoutRetry).toMatchObject({ mode: "read-only" });
          expect(scoutRetry?.advertisedTools).toEqual(
            expect.not.arrayContaining(["edit", "write", "bash"]),
          );
          expect(scoutRetry?.toolResults).toEqual(
            expect.arrayContaining([expect.objectContaining({ toolName: "edit", isError: true })]),
          );

          expect(verifierFinal).toMatchObject({ mode: "verify-only" });
          expect(verifierFinal?.advertisedTools).toEqual(expect.arrayContaining(["verification"]));
          expect(verifierFinal?.advertisedTools).toEqual(
            expect.not.arrayContaining(["edit", "write", "bash"]),
          );
          expect(verifierFinal?.toolResults).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ toolName: "write", isError: true }),
              expect.objectContaining({ toolName: "bash", isError: true }),
            ]),
          );
        } finally {
          session?.dispose();
          if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
          else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
          if (previousOffline === undefined) delete process.env.PI_OFFLINE;
          else process.env.PI_OFFLINE = previousOffline;
          if (previousAuditPath === undefined) delete process.env[AUDIT_ENV];
          else process.env[AUDIT_ENV] = previousAuditPath;
          if (previousTarget === undefined) delete process.env[TARGET_ENV];
          else process.env[TARGET_ENV] = previousTarget;
          await rm(agentDir, { force: true, recursive: true });
        }
      },
    );
  }, 120_000);
});
