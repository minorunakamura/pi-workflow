import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const PI_SUBAGENTS_SOURCE = join(PROJECT_ROOT, "node_modules", "pi-subagents");
const REQUEST_EVENT = "prompt-template:subagent:request";
const RESPONSE_EVENT = "prompt-template:subagent:response";
const COPY_RUNTIME_DEPENDENCIES = ["jiti", "typebox", "yaml"] as const;

type PackageEntry =
  | string
  | {
      source: string;
      autoload?: boolean;
      extensions?: string[];
    };

type Topology = Readonly<{
  extensionPaths: string[];
  errors: Array<{ path: string; error: string }>;
  responseCount: number;
  skillPaths: string[];
}>;

async function copyPiSubagentsPackage(
  packageRoot: string,
  dependencyRoot: string,
  version?: string,
): Promise<void> {
  await mkdir(dependencyRoot, { recursive: true });
  await cp(PI_SUBAGENTS_SOURCE, packageRoot, { recursive: true, dereference: true });
  await Promise.all(
    COPY_RUNTIME_DEPENDENCIES.map((dependency) =>
      cp(join(PROJECT_ROOT, "node_modules", dependency), join(dependencyRoot, dependency), {
        recursive: true,
        dereference: true,
      }),
    ),
  );
  if (version !== undefined) {
    const packageJsonPath = join(packageRoot, "package.json");
    const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
    packageJson.version = version;
    await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  }
}

async function probeBridgeCount(events: ReturnType<typeof createEventBus>): Promise<number> {
  let responseCount = 0;
  const unsubscribe = events.on(RESPONSE_EVENT, () => {
    responseCount += 1;
  });
  events.emit(REQUEST_EVENT, {
    requestId: "topology-probe-request",
    ownerRunId: "topology-probe-owner",
    nodeId: "topology-probe-node",
    agent: "worker",
    task: "",
    result: { kind: "invalid" },
  });
  await new Promise<void>((done) => setImmediate(done));
  unsubscribe();
  return responseCount;
}

async function loadTopology(
  root: string,
  agentDir: string,
  globalPackages: readonly PackageEntry[],
  projectPackages: readonly PackageEntry[],
): Promise<Topology> {
  const events = createEventBus();

  const settingsManager = SettingsManager.inMemory(
    { packages: [...globalPackages] },
    { projectTrusted: true },
  );
  settingsManager.setProjectPackages([...projectPackages]);
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager,
    eventBus: events,
  });
  await resourceLoader.reload();

  const extensions = resourceLoader.getExtensions();
  return {
    extensionPaths: extensions.extensions.map(({ path }) => path),
    errors: extensions.errors,
    responseCount: await probeBridgeCount(events),
    skillPaths: resourceLoader.getSkills().skills.map(({ filePath }) => filePath),
  };
}

describe("Pi package single-owner topology", () => {
  it("shows why unfiltered nested and global package roots are unsafe", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workflow-topology-"));
    try {
      const agentDir = join(root, "agent");
      await copyPiSubagentsPackage(
        join(agentDir, "npm", "node_modules", "pi-subagents"),
        join(agentDir, "npm", "node_modules"),
      );
      const topology = await loadTopology(root, agentDir, ["npm:pi-subagents"], [PROJECT_ROOT]);

      expect(topology.responseCount).toBe(2);
      expect(topology.extensionPaths).toEqual(
        expect.arrayContaining([
          join(PROJECT_ROOT, "node_modules", "pi-subagents", "index.ts"),
          join(agentDir, "npm", "node_modules", "pi-subagents", "index.ts"),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([
    {
      name: "clean pi-workflow consumer",
      globalPackages: [] as PackageEntry[],
      projectPackages: [PROJECT_ROOT] as PackageEntry[],
    },
    {
      name: "global pi-subagents with project delta filter",
      globalPackages: ["npm:pi-subagents"] as PackageEntry[],
      projectPackages: [
        { source: "npm:pi-subagents", autoload: false, extensions: ["!index.ts"] },
        PROJECT_ROOT,
      ] as PackageEntry[],
    },
  ])(
    "keeps $name at one active bridge",
    async ({ globalPackages, projectPackages }) => {
      const root = await mkdtemp(join(tmpdir(), "pi-workflow-topology-"));
      try {
        const agentDir = join(root, "agent");
        if (globalPackages.length > 0) {
          await copyPiSubagentsPackage(
            join(agentDir, "npm", "node_modules", "pi-subagents"),
            join(agentDir, "npm", "node_modules"),
          );
        }
        const topology = await loadTopology(root, agentDir, globalPackages, projectPackages);

        expect(topology.responseCount).toBe(1);
        expect(topology.errors).toEqual([]);
        expect(topology.extensionPaths).toEqual([
          join(PROJECT_ROOT, "src", "extensions", "workflow.ts"),
          join(PROJECT_ROOT, "node_modules", "pi-subagents", "index.ts"),
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("filters a project-local pi-subagents package without filtering its resources", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workflow-topology-"));
    try {
      const localPackage = join(root, "project-pi-subagents");
      await copyPiSubagentsPackage(localPackage, join(localPackage, "node_modules"));
      const topology = await loadTopology(
        root,
        join(root, "agent"),
        [],
        [{ source: localPackage, extensions: ["!index.ts"] }, PROJECT_ROOT],
      );

      expect(topology.responseCount).toBe(1);
      expect(topology.errors).toEqual([]);
      expect(topology.extensionPaths).not.toContain(join(localPackage, "index.ts"));
      expect(topology.extensionPaths).toContain(
        join(PROJECT_ROOT, "node_modules", "pi-subagents", "index.ts"),
      );
      expect(topology.skillPaths).toContain(
        join(localPackage, "skills", "pi-subagents", "SKILL.md"),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps one bundled owner with global, project-local, and different-version package metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workflow-topology-"));
    try {
      const agentDir = join(root, "agent");
      const localPackage = join(root, "project-pi-subagents");
      await copyPiSubagentsPackage(
        join(agentDir, "npm", "node_modules", "pi-subagents"),
        join(agentDir, "npm", "node_modules"),
        "0.65.0",
      );
      await copyPiSubagentsPackage(localPackage, join(localPackage, "node_modules"), "0.64.0");
      const topology = await loadTopology(
        root,
        agentDir,
        ["npm:pi-subagents"],
        [
          { source: "npm:pi-subagents", autoload: false, extensions: ["!index.ts"] },
          { source: localPackage, extensions: ["!index.ts"] },
          PROJECT_ROOT,
        ],
      );

      expect(topology.responseCount).toBe(1);
      expect(topology.errors).toEqual([]);
      expect(topology.extensionPaths).toEqual([
        join(PROJECT_ROOT, "src", "extensions", "workflow.ts"),
        join(PROJECT_ROOT, "node_modules", "pi-subagents", "index.ts"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("disposes the bridge before a reload and registers one owner again", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-workflow-topology-"));
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const agentDir = join(root, "agent");
      await copyPiSubagentsPackage(
        join(agentDir, "npm", "node_modules", "pi-subagents"),
        join(agentDir, "npm", "node_modules"),
      );
      const events = createEventBus();
      const settingsManager = SettingsManager.inMemory(
        { packages: ["npm:pi-subagents"] },
        { projectTrusted: true },
      );
      settingsManager.setProjectPackages([
        { source: "npm:pi-subagents", autoload: false, extensions: ["!index.ts"] },
        PROJECT_ROOT,
      ]);
      const resourceLoader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager,
        eventBus: events,
      });
      await resourceLoader.reload();
      const faux = fauxProvider({
        provider: "pi-workflow-topology",
        models: [{ id: "test", input: ["text"], reasoning: false }],
      });
      session = (
        await createAgentSession({
          cwd: root,
          agentDir,
          model: faux.getModel(),
          resourceLoader,
          sessionManager: SessionManager.inMemory(root),
          settingsManager,
        })
      ).session;
      await session.bindExtensions({ mode: "json" });

      await expect(probeBridgeCount(events)).resolves.toBe(1);
      await session.reload();
      await expect(probeBridgeCount(events)).resolves.toBe(1);
    } finally {
      session?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
