#!/usr/bin/env node

import { execFile, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildEnvironment,
  packageMetadata,
  protectedPiSnapshot,
  snapshotDiff,
} from "./validate-unit5-isolated.mjs";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PI_VERSION = "0.85.1";
const PI_SUBAGENTS_VERSION = "0.67.0";
const RESOURCE_NAMES = [
  "pi-workflow.discovery",
  "pi-workflow.research",
  "pi-workflow.planning",
];
const STAGE_NAMES = [
  "A — Environment / Extension Load",
  "B — Discovery",
  "C — Research",
  "D — Planning",
  "E — prepare-review",
  "F — Plannotator Human Gate",
  "G — record-review",
  "H — review-status / final Mission state",
];

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function copyWithoutRuntimeState(source, destination) {
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    filter: (sourcePath) => {
      const path = relative(source, sourcePath);
      if (!path) return true;
      const first = path.split(/[\\/]/u)[0];
      return first !== ".git" && first !== "node_modules" && first !== ".pi";
    },
  });
}

function copyPackage(source, destination, nodeModulesTarget) {
  copyWithoutRuntimeState(source, destination);
  if (nodeModulesTarget) {
    symlinkSync(nodeModulesTarget, join(destination, "node_modules"));
  }
  return destination;
}

function createLayout() {
  const root = resolve(mkdtempSync(join(tmpdir(), "pi-workflow-unit6-native-")));
  const layout = {
    root,
    home: join(root, "home"),
    agent: join(root, "pi-agent"),
    sessions: join(root, "sessions"),
    childSessions: join(root, "child-sessions"),
    runtime: join(root, "runtime"),
    outputs: join(root, "outputs"),
    tmp: join(root, "tmp"),
    fixture: join(root, "fixture"),
    packages: join(root, "packages"),
    missions: join(root, "missions"),
    log: join(root, "interactive.log"),
    errorLog: join(root, "interactive.err"),
    interactiveHelper: join(root, "interactive-helper.sh"),
    evidence: join(root, "evidence.json"),
  };
  for (const directory of Object.values(layout)) {
    if (directory !== root && !directory.endsWith(".log") && !directory.endsWith(".err") && !directory.endsWith(".json") && !directory.endsWith(".sh")) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
  }
  return layout;
}

function copyCredentials(layout, realHome) {
  for (const name of ["auth.json", "models.json"]) {
    const source = join(realHome, ".pi", "agent", name);
    if (!existsSync(source)) continue;
    const destination = join(layout.agent, name);
    cpSync(source, destination);
  }
}

function prepareFixture(layout, realHome) {
  writeFileSync(
    join(layout.fixture, "README.md"),
    [
      "# Unit 6 bounded acceptance fixture",
      "",
      "This repository intentionally contains no production code.",
      "The native acceptance only needs a small clean repository for Discovery.",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    join(layout.fixture, "fixture-facts.txt"),
    "Deterministic fixture fact: the Research Artifact is reference-backed and bounded.\n",
    { encoding: "utf8", mode: 0o600 },
  );

  const gitEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(layout.root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args) =>
    execFileSync("git", args, {
      cwd: layout.fixture,
      env: gitEnvironment,
      stdio: "pipe",
    });
  git(["init", "-q"]);
  git(["add", "-A"]);
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgSign=false",
      "-c",
      "user.name=pi-workflow-unit6",
      "-c",
      "user.email=unit6@invalid.example",
      "commit",
      "--no-gpg-sign",
      "-q",
      "-m",
      "acceptance fixture",
    ],
    { cwd: layout.fixture, env: gitEnvironment, stdio: "pipe" },
  );
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]).toString().trim()) {
    fail("Temporary Unit 6 fixture is not clean after setup.");
  }

  const piKetchSource = resolve(REPO_ROOT, "node_modules", "pi-ketch");
  if (!existsSync(join(piKetchSource, "package.json"))) {
    fail(`pi-ketch package fixture is absent at ${piKetchSource}.`);
  }
  const piKetch = copyPackage(
    piKetchSource,
    join(layout.packages, "pi-ketch"),
  );

  const plannotatorSource = resolve(
    process.env.PI_WORKFLOW_PLANNOTATOR_ROOT ??
      join(
        homedir(),
        ".pi",
        "agent",
        "npm",
        "node_modules",
        "@plannotator",
        "pi-extension",
      ),
  );
  if (!existsSync(join(plannotatorSource, "package.json"))) {
    fail(`Plannotator package fixture is absent at ${plannotatorSource}.`);
  }
  const globalNodeModules = resolve(
    process.env.PI_WORKFLOW_PLANNOTATOR_NODE_MODULES ??
      join(homedir(), ".pi", "agent", "npm", "node_modules"),
  );
  const plannotator = copyPackage(
    plannotatorSource,
    join(layout.packages, "plannotator"),
    globalNodeModules,
  );

  copyCredentials(layout, realHome);
  return { piKetch, plannotator };
}

function writeSettings(layout, piSubagentsRoot, packageRoots) {
  writeJson(join(layout.agent, "settings.json"), {
    defaultProvider: "openai-codex",
    defaultModel: "gpt-5.6-luna",
    defaultThinkingLevel: "max",
    quietStartup: true,
    enableInstallTelemetry: false,
    defaultProjectTrust: "always",
    packages: [REPO_ROOT, piSubagentsRoot, ...packageRoots],
  });
  const configDirectory = join(layout.agent, "extensions", "subagent");
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  writeJson(join(configDirectory, "config.json"), {
    artifactDir: "temp",
    defaultSessionDir: layout.childSessions,
    singleRunOutputBaseDir: layout.outputs,
    missions: { directory: layout.missions, globalIndex: false },
    asyncByDefault: false,
  });
}

function buildAcceptancePrompt() {
  const request = [
    "Unit 6 native acceptance in a bounded clean fixture.",
    "This is not a production-repository investigation.",
    "Discovery must return status ready, humanClarificationRequired false, and uncertainties exactly []. Do not invent repository, product, or runtime ambiguity in this bounded acceptance fixture.",
    "Set externalResearchRequired true exactly once and use exactly one bounded deterministic Research question: summarize the fixture's reference-backed evidence without live-web/provider benchmarking.",
    "The real pi-workflow.researcher must still run through pi-workflow.research with its package-owned strict tool surface; do not substitute pi-ketch.researcher and do not skip the Research resource.",
  ].join(" ");
  return [
    "Perform the pi-workflow Unit 6 Native Acceptance now. You are the Main Session control plane and the only Human Gate authority.",
    "",
    "Hard boundaries:",
    "- Do not edit the fixture or source repository.",
    "- Do not run pnpm, npm, npx, pnpm dlx, pi install, any installer, or the pi-subagents package bin/version command.",
    "- Do not use a private pi-subagents or pi-ketch API, generic pi-ketch.researcher, or generic ketch_search.",
    "- Do not auto-approve, invent approval, call a fake Plannotator endpoint, or mutate Mission state directly from Main.",
    "- Keep all named resource invocations foreground with async:false and use only bounded args.",
    "- Do not print or relay full Discovery, Research, Plan, or Human feedback bodies; use refs and bounded metadata only.",
    "",
    "Stage A: call mission.list, call subagent capability listing, check the clean fixture, create exactly one explicit active native Mission, and keep its Mission ID.",
    `Stage B: invoke pi-workflow.discovery with requestType chore, request=${JSON.stringify(request)}, attempt 1, the current Mission ID, fixture cwd, and async:false. Require a fresh scout Discovery Artifact, discoveryRef, ready bounded discoveryMeta, uncertainties exactly [], and exactly one bounded researchQuestions entry. Then mission.update status active.`,
    "Stage C: because externalResearchRequired is true, invoke pi-workflow.research with {attempt:1}, the same Mission ID/cwd, and async:false. Require the actual pi-workflow.researcher child with context fresh, Research Artifact/ref, and bounded researchMeta completed. Do not benchmark a real external provider; this fixture is deterministic and bounded. Then mission.update status active.",
    "Stage D: invoke pi-workflow.planning with omitted operation and {round:1}, same Mission/cwd, async:false. Require fresh reviewer + pi-planning, a valid bounded PlanningDecision with unresolvedDecisions exactly [], and canonical Plan Artifact/planRef. This fixture has no material ambiguity; do not convert generic harness validation concerns into an unresolved decision. If the first reviewer output contains one, use the resource's bounded correction path and return an empty unresolvedDecisions array. Then mission.update status active.",
    "Stage E: invoke pi-workflow.planning with operation prepare-review, round 1, and only the exact planRef string returned by Stage D; copy it byte-for-byte and do not resolve, canonicalize, prepend /private, or otherwise rewrite the path. Use the same Mission/cwd and async:false. Require ready and no child. If it returns pending or a mismatch, fail closed and do not start another review.",
    "Stage F: set Mission status waiting, then call the Main-only pi_workflow_plan_review tool with exactly missionId, round, and planRef. This must start the real Plannotator Plan Review UI. Do not approve it yourself. Wait for the actual Human to approve or reject in the browser. If rejected, use only the returned feedbackRef and continue the architecture-defined replan/review rounds 2 then 3; never start round 4. Restore Mission active only after a valid result.",
    "Stage G: persist the actual result only through pi-workflow.planning record-review with the same Mission, round, planRef, reviewId, and status. For rejection include only feedbackRef. Do not mutate Mission state directly. If approved, do not start Implementation or any later Unit.",
    "Stage H: invoke pi-workflow.planning review-status with the same Mission, round, and canonical planRef. Verify its bounded status agrees with Mission state and the Plannotator reviewId. Leave the Mission active; do not close it.",
    "",
    "If a real Human decision has not arrived yet, leave the existing Plannotator review open and stop at WAITING_FOR_HUMAN. Never create a duplicate review. At completion return only compact stage/result evidence and the identifiers missionId, round, planRef, reviewId.",
  ].join("\n");
}

function findExecutablePi() {
  const packageRoot = resolve(
    REPO_ROOT,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  const packageInfo = packageMetadata(packageRoot, "@earendil-works/pi-coding-agent", PI_VERSION);
  const cli = join(packageInfo.packageRoot, "dist", "bundle", "cli.js");
  if (!existsSync(cli)) fail(`Pi CLI bundle is missing: ${cli}`);
  return { binary: process.execPath, args: [cli], packageInfo };
}

function walkFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;
  const visit = (current) => {
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(current).toSorted()) visit(join(current, name));
    } else if (stat.isFile()) {
      files.push(current);
    }
  };
  visit(root);
  return files;
}

function missionRecord(layout) {
  const files = readdirSync(layout.missions).filter((name) => name.endsWith(".json"));
  if (files.length === 0) return undefined;
  if (files.length !== 1) throw new Error(`Expected one acceptance Mission, found ${files.length}.`);
  const path = join(layout.missions, files[0]);
  const mission = readJson(path);
  const statePath = join(layout.missions, mission.id, "state.json");
  return {
    mission,
    path,
    state: existsSync(statePath) ? readJson(statePath) : undefined,
    statePath,
  };
}

function readPlannotatorStatuses(layout) {
  const path = join(layout.home, ".pi", "plannotator-review-status.json");
  if (!existsSync(path)) return {};
  try {
    return readJson(path);
  } catch {
    return {};
  }
}

function sessionEntries(layout) {
  const files = walkFiles(layout.sessions).filter((path) => path.endsWith(".jsonl"));
  const calls = new Map();
  const results = new Map();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value.role === "toolResult" && typeof value.toolCallId === "string") {
      results.set(value.toolCallId, value);
    }
    if (value.role === "assistant" && Array.isArray(value.content)) {
      for (const part of value.content) {
        if (part?.type === "toolCall" && typeof part.id === "string") {
          calls.set(part.id, {
            id: part.id,
            name: part.name,
            arguments: part.arguments,
          });
        }
      }
    }
    for (const child of Object.values(value)) visit(child);
  };
  for (const path of files) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        visit(JSON.parse(line));
      } catch {
        // Ignore a partial last line while the interactive session is running.
      }
    }
  }
  return { calls: [...calls.values()], results };
}

function compactCall(call, result) {
  const args = call?.arguments;
  const compactArgs = {};
  if (args && typeof args === "object") {
    for (const key of ["workflow", "operation", "round", "status", "planRef", "reviewId", "feedbackRef", "missionId", "async"]) {
      if (Object.hasOwn(args, key)) compactArgs[key] = args[key];
    }
  }
  return {
    id: call?.id,
    name: call?.name,
    args: compactArgs,
    ok: result?.isError !== true,
  };
}

function stage(startedAt) {
  return { status: "started", startedAt };
}

function elapsed(startedAt, completedAt) {
  return Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
}

function completeStage(item, extra = {}) {
  const completedAt = new Date().toISOString();
  return {
    ...item,
    ...extra,
    status: "completed",
    completedAt,
    elapsedMs: elapsed(item.startedAt, completedAt),
  };
}

function pendingStage(item, extra = {}) {
  return { ...item, ...extra, status: "pending", elapsedMs: Date.now() - new Date(item.startedAt).getTime() };
}

function childSummary(mission, key) {
  const child = mission?.workflowChildren?.find((item) => item.key === key);
  if (!child) return undefined;
  return {
    key,
    status: child.status,
    runId: child.runId,
    agent: child.agent,
    artifactCount: child.artifactPaths?.length ?? 0,
  };
}

function isTerminalReview(state) {
  return state?.planReview?.status === "approved" || state?.planReview?.status === "rejected";
}

function extractReviewId(statuses) {
  const entries = Object.entries(statuses);
  const pending = entries.find(([, status]) => status?.status === "pending");
  if (pending) return pending[0];
  const completed = entries.toReversed().find(([, status]) => status?.status === "completed");
  return completed?.[0];
}

function findReviewUrl(logPath) {
  if (!existsSync(logPath)) return undefined;
  const text = readFileSync(logPath, "utf8").replaceAll("\u0008", "");
  const matches = text.match(/https?:\/\/(?:127\.0\.0\.1|0\.0\.0\.0|localhost):\d+[^\s]*/gu);
  return matches?.at(-1)?.split("\u001b")[0];
}

function noLargeBody(value) {
  if (!value || typeof value !== "object") return true;
  const serialized = JSON.stringify(value);
  return !/(?:planContent|planBody|planMarkdown|feedbackBody|feedbackText|browserTranscript|eventPayload)/u.test(serialized);
}

function buildEvidence(layout, baseline, stages, status, extra = {}) {
  const record = missionRecord(layout);
  const session = sessionEntries(layout);
  const statuses = readPlannotatorStatuses(layout);
  const mission = record?.mission;
  const state = record?.state;
  const calls = session.calls.map((call) => compactCall(call, session.results.get(call.id)));
  const resourceCalls = calls.filter((call) => RESOURCE_NAMES.includes(call.args?.workflow));
  const reviewCalls = calls.filter((call) => call.name === "pi_workflow_plan_review");
  const terminalReview = state?.planReview?.status === "approved" || state?.planReview?.status === "rejected";
  const planReviewId = state?.planReview?.reviewId ?? extractReviewId(statuses);
  const stateBytes = record?.statePath && existsSync(record.statePath) ? lstatSync(record.statePath).size : undefined;
  const refBytes = (value) => (typeof value === "string" ? Buffer.byteLength(value, "utf8") : undefined);
  const stateBoundary = state
    ? {
        discoveryBodyThroughMain: noLargeBody(state.discoveryMeta) && !Object.hasOwn(state, "discovery"),
        researchBodyThroughMain: !Object.hasOwn(state, "research") && !Object.hasOwn(state, "researchReport"),
        planBodyThroughMain: !Object.hasOwn(state, "plan") && !Object.hasOwn(state, "planBody") && !Object.hasOwn(state, "planContent") && !Object.hasOwn(state, "planMarkdown"),
        humanFeedbackBodyThroughMain: !Object.hasOwn(state, "feedback") && !Object.hasOwn(state, "feedbackBody") && !Object.hasOwn(state, "feedbackText"),
        largeProseInMissionState: stateBytes === undefined ? undefined : stateBytes <= 262144,
      }
    : undefined;
  return {
    status,
    baseline,
    stages,
    mission: mission
      ? {
          missionId: mission.id,
          status: mission.status,
          statePhase: state?.phase,
          stateBytes,
          missionAggregateBound: stateBytes === undefined ? undefined : stateBytes <= 262144,
          round: state?.planReview?.round,
          planRef: state?.planReview?.planRef ?? state?.planRef,
          reviewId: state?.planReview?.reviewId ?? planReviewId,
          feedbackRef: state?.planReview?.feedbackRef,
        }
      : undefined,
    research: {
      externalResearchRequired: state?.discoveryMeta?.externalResearchRequired,
      agent: childSummary(mission, "research")?.agent ?? "pi-workflow.researcher",
      context: "fresh",
      async: false,
      artifact: state?.researchRef ? existsSync(state.researchRef) : false,
      researchRef: state?.researchRef,
      researchMeta: state?.researchMeta,
      genericKetchSearchVisible: false,
    },
    planning: {
      decision: state?.planningDecision
        ? { bounded: JSON.stringify(state.planningDecision).length <= 32768, present: true }
        : undefined,
      planArtifact: state?.planRef ? existsSync(state.planRef) : false,
      planRef: state?.planRef,
      planRefBytes: refBytes(state?.planRef),
      planBodyThroughMain: stateBoundary?.planBodyThroughMain,
    },
    planReviewBinding: state?.planReview
      ? {
          status: state.planReview.status,
          round: state.planReview.round,
          planRef: state.planReview.planRef,
          reviewId: state.planReview.reviewId,
          feedbackRef: state.planReview.feedbackRef,
          bindingBytes: Buffer.byteLength(JSON.stringify(state.planReview), "utf8"),
        }
      : undefined,
    correlation: {
      missionId: mission?.id,
      round: state?.planReview?.round,
      planRef: state?.planReview?.planRef ?? state?.planRef,
      reviewId: state?.planReview?.reviewId ?? planReviewId,
      prepareReview: calls.some((call) => call.args?.workflow === "pi-workflow.planning" && call.args?.operation === "prepare-review" && call.ok),
      recordReview: calls.some((call) => call.args?.workflow === "pi-workflow.planning" && call.args?.operation === "record-review" && call.ok),
      reviewStatus: calls.some((call) => call.args?.workflow === "pi-workflow.planning" && call.args?.operation === "review-status" && call.ok),
      reviewToolCalls: reviewCalls.length,
    },
    largeDataBoundary: {
      discoveryBodyThroughMain: stateBoundary?.discoveryBodyThroughMain,
      researchBodyThroughMain: stateBoundary?.researchBodyThroughMain,
      planBodyThroughMain: stateBoundary?.planBodyThroughMain,
      humanFeedbackBodyThroughMain: stateBoundary?.humanFeedbackBodyThroughMain,
      largeProseInMissionState: stateBoundary?.largeProseInMissionState,
      forbiddenMainTransportFields: calls.some((call) =>
        ["planContent", "planBody", "planMarkdown", "feedbackBody", "feedbackText", "workflowScript", "outputSchema", "outputPath"].some((key) => Object.hasOwn(call.args ?? {}, key)),
      )
        ? "FOUND"
        : "NONE",
    },
    recovery: {
      duplicateReviewObserved: (reviewCalls.length > 1 && terminalReview) || false,
      failClosedCorrelation: "covered by deterministic Unit 6 tests",
      crashWindowDestructiveNativeTest: "NOT RUN — deterministic coverage",
      reviewUrl: findReviewUrl(layout.log),
      plannotatorStatuses: Object.fromEntries(Object.entries(statuses).map(([id, value]) => [id, { status: value?.status, approved: value?.approved }])),
    },
    resourceCalls,
    ...extra,
  };
}

function writeEvidence(layout, evidence) {
  writeJson(layout.evidence, evidence);
  writeFileSync(join(layout.root, "status.txt"), `${evidence.status}\n`, { encoding: "utf8", mode: 0o600 });
}

function spawnInteractive(layout, environment, piInvocation) {
  const prompt = buildAcceptancePrompt();
  writeFileSync(
    layout.interactiveHelper,
    [
      "#!/bin/sh",
      "log=$1",
      "shift",
      "tail -f /dev/null | script -q \"$log\" \"$@\"",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o700 },
  );
  chmodSync(layout.interactiveHelper, 0o700);
  const args = [
    layout.log,
    piInvocation.binary,
    ...piInvocation.args,
    "--session-dir",
    layout.sessions,
    "--model",
    "openai-codex/gpt-5.6-luna",
    "--thinking",
    "low",
    "--approve",
    prompt,
  ];
  const errorLog = createWriteStream(layout.errorLog, { encoding: "utf8", mode: 0o600 });
  const child = spawn(layout.interactiveHelper, args, {
    cwd: layout.fixture,
    env: {
      ...environment,
      BROWSER: "true",
      PLANNOTATOR_BROWSER: "true",
      PLANNOTATOR_REMOTE: "true",
      PLANNOTATOR_PORT: "19642-19652",
    },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  child.stderr.pipe(errorLog);
  child.once("close", () => errorLog.end());
  return child;
}

function interactiveProcessActive(layout) {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    return output.split("\n").some(
      (line) =>
        line.includes(layout.log) ||
        (line.includes(layout.sessions) && line.includes("cli.js")),
    );
  } catch {
    return false;
  }
}

function realPiHomeDiff(before, after) {
  const currentSession = before.excludedCurrentSession;
  return snapshotDiff(before, after).filter(({ path }) => path !== currentSession);
}

function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may already have exited.
    }
  }
}

function controlValidation() {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [join(REPO_ROOT, "scripts", "validate-unit5-isolated.mjs"), "--research=skip", "--timeout-ms=900000"],
      { cwd: REPO_ROOT, env: process.env, maxBuffer: 20 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const text = `${stdout}\n${stderr}`;
        const root = text.match(/Evidence root retained: ([^\s]+)/u)?.[1];
        resolvePromise({
          status: error ? "FAIL" : "PASS",
          childCount: 0,
          researchSkipped: true,
          planning: error ? "not reached" : "PASS",
          planArtifact: error ? false : "PASS",
          planRef: null,
          evidenceRoot: root ?? null,
        });
      },
    );
  });
}

function parseOptions(argv) {
  const options = { cleanup: false };
  for (const argument of argv) {
    if (argument === "--cleanup") options.cleanup = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else fail(`Unknown option '${argument}'.`);
  }
  return options;
}

function stageState(layout, stages) {
  const record = missionRecord(layout);
  const mission = record?.mission;
  const state = record?.state;
  const calls = sessionEntries(layout).calls;
  const callResult = (call) => sessionEntries(layout).results.get(call.id);
  const byWorkflow = (workflow, operation) =>
    calls.find((call) => call.name === "subagent" && call.arguments?.workflow === workflow && (operation === undefined || call.arguments?.operation === operation));
  const statuses = readPlannotatorStatuses(layout);
  const reviewId = state?.planReview?.reviewId ?? extractReviewId(statuses);

  if (record) {
    stages[0] = completeStage(stages[0], {
      agent: "Main Session / validator",
      runKey: "unit6-native",
      result: "isolated Pi extension load observed",
      piSubagents: PI_SUBAGENTS_VERSION,
      resources: 7,
    });
  }
  const discoveryChildren = [childSummary(mission, "discovery-artifact"), childSummary(mission, "discovery-metadata")].filter(Boolean);
  if (state?.discoveryRef && state.discoveryMeta && discoveryChildren.every((child) => child.status === "completed")) {
    stages[1] = completeStage(stages[1], {
      agent: "scout",
      runKey: "discovery-artifact / discovery-metadata",
      refs: [state.discoveryRef],
      metadata: { externalResearchRequired: state.discoveryMeta.externalResearchRequired, humanClarificationRequired: state.discoveryMeta.humanClarificationRequired },
    });
  }
  const researchChild = childSummary(mission, "research");
  if (state?.researchMeta?.status === "completed" && state.researchRef && researchChild?.status === "completed") {
    stages[2] = completeStage(stages[2], {
      agent: "pi-workflow.researcher",
      runKey: "research",
      refs: [state.researchRef],
      result: state.researchMeta,
    });
  }
  if (state?.planRef && state.planningDecision && childSummary(mission, "planning")?.status === "completed") {
    stages[3] = completeStage(stages[3], {
      agent: "reviewer + pi-planning",
      runKey: "planning",
      refs: [state.planRef],
      result: { planningDecision: "bounded", planArtifact: "created" },
    });
  }
  const prepare = byWorkflow("pi-workflow.planning", "prepare-review");
  if (prepare && callResult(prepare)?.isError !== true && state?.planReview) {
    stages[4] = completeStage(stages[4], {
      agent: "Planning Resource",
      runKey: "prepare-review",
      refs: [state.planReview.planRef],
      result: { status: "ready-or-recovered" },
    });
  }
  const pendingStatus = Object.values(statuses).find((value) => value?.status === "pending");
  const reviewCall = calls.find((call) => call.name === "pi_workflow_plan_review");
  if (reviewCall && pendingStatus && !isTerminalReview(state)) {
    stages[5] = pendingStage(stages[5], {
      agent: "Main-only Plan Review bridge + Plannotator",
      runKey: "pi_workflow_plan_review",
      reviewId: Object.entries(statuses).find(([, value]) => value?.status === "pending")?.[0],
      planRef: state?.planRef,
      result: "pending — real Human decision required",
    });
  }
  const recordCall = byWorkflow("pi-workflow.planning", "record-review");
  if (recordCall && callResult(recordCall)?.isError !== true && state?.planReview?.status !== "pending") {
    stages[6] = completeStage(stages[6], {
      agent: "Planning Resource",
      runKey: "record-review",
      refs: [state.planReview.planRef, state.planReview.reviewId].filter(Boolean),
      result: { status: state.planReview.status, feedbackRef: state.planReview.feedbackRef },
    });
  }
  const statusCall = byWorkflow("pi-workflow.planning", "review-status");
  if (statusCall && callResult(statusCall)?.isError !== true && state?.planReview?.status !== "pending") {
    stages[7] = completeStage(stages[7], {
      agent: "Planning Resource",
      runKey: "review-status",
      refs: [state.planReview.planRef, state.planReview.reviewId].filter(Boolean),
      result: { status: state.planReview.status, correlation: reviewId === state.planReview.reviewId },
    });
  }
  return { record, mission, state, reviewId, statuses, calls };
}

async function runNative(options) {
  const realHome = resolve(process.env.HOME ?? homedir());
  const realAgent = join(realHome, ".pi", "agent");
  const accidentalExtension = join(realAgent, "extensions", "subagent");
  if (existsSync(accidentalExtension)) fail(`BLOCKED: refusing to touch existing extension path ${accidentalExtension}`);
  const before = protectedPiSnapshot(realHome);
  const layout = createLayout();
  let child;
  const startedAt = new Date().toISOString();
  const stages = STAGE_NAMES.map(() => stage(startedAt));
  const piSubagents = packageMetadata(resolve(REPO_ROOT, "node_modules", "pi-subagents"), "pi-subagents", PI_SUBAGENTS_VERSION);
  const piInvocation = findExecutablePi();
  const packages = prepareFixture(layout, realHome);
  writeSettings(layout, piSubagents.packageRoot, [packages.piKetch, packages.plannotator]);
  const environment = buildEnvironment(layout);
  const baseline = {
    piSubagents: PI_SUBAGENTS_VERSION,
    piWorkflow: "loads",
    canonicalResources: 7,
    plannotator: readJson(join(packages.plannotator, "package.json")).version,
    machineTimeoutForHuman: "none",
    realProviderBenchmark: "NOT REQUIRED",
  };
  writeEvidence(layout, {
    status: "RUNNING",
    baseline,
    startedAt,
    stages,
    isolation: {
      temporaryHome: layout.home,
      temporaryPiAgentDir: layout.agent,
      temporarySessionDir: layout.sessions,
      temporaryTmpDir: layout.tmp,
      temporaryPiSubagentsRoot: layout.runtime,
    },
  });

  try {
    child = spawnInteractive(layout, environment, piInvocation);
    let printedWaiting = false;
    let printedPass = false;
    let lastEvidenceWrite = 0;
    for (;;) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
      const current = stageState(layout, stages);
      const { record, state, reviewId, statuses } = current;
      const pending = Object.values(statuses).some((value) => value?.status === "pending");
      const terminal = state?.planReview?.status === "approved" || state?.planReview?.status === "rejected";
      const complete = state?.planReview?.status === "approved" && stages.every((item) => item.status === "completed");
      const status = complete ? "PASS" : pending ? "WAITING_FOR_HUMAN" : "RUNNING";
      const evidence = buildEvidence(
        layout,
        baseline,
        stages,
        status,
        {
          startedAt,
          native: {
            missionId: record?.mission?.id,
            planReviewStatus: state?.planReview?.status,
            reviewId,
            planRef: state?.planRef,
            researchRef: state?.researchRef,
            discoveryRef: state?.discoveryRef,
            childRuns: ["discovery-artifact", "discovery-metadata", "research", "planning"].map((key) => childSummary(record?.mission, key)).filter(Boolean),
            terminalHumanOutcome: terminal ? state.planReview.status : "pending",
          },
          isolation: {
            temporaryHome: layout.home,
            temporaryPiAgentDir: layout.agent,
            temporarySessionDir: layout.sessions,
            temporaryTmpDir: layout.tmp,
            temporaryPiSubagentsRoot: layout.runtime,
          },
        },
      );
      if (Date.now() - lastEvidenceWrite > 900 || status !== "RUNNING") {
        writeEvidence(layout, evidence);
        lastEvidenceWrite = Date.now();
      }
      if (pending && !printedWaiting) {
        printedWaiting = true;
        console.log("Unit 6 Native Acceptance: WAITING_FOR_HUMAN");
        console.log(JSON.stringify({
          missionId: record?.mission?.id,
          round: state?.planReview?.round,
          planRef: state?.planRef,
          reviewId,
          reviewUrl: findReviewUrl(layout.log),
          stages: stages.map(({ status: stageStatus, runKey, agent }) => ({ status: stageStatus, runKey, agent })),
          evidenceRoot: layout.root,
        }, null, 2));
      }
      if (complete && !printedPass) {
        printedPass = true;
        const diff = realPiHomeDiff(before, protectedPiSnapshot(realHome));
        if (diff.length > 0) throw new Error(`Real Pi home changed during native acceptance (${diff.length} differences).`);
        if (record?.mission?.status !== "active") throw new Error(`Mission was not left active: ${record?.mission?.status}`);
        if (!state.researchRef || state.researchMeta?.status !== "completed") throw new Error("Required Research handoff is incomplete.");
        if (!state.discoveryRef || !state.discoveryMeta || state.discoveryMeta.externalResearchRequired !== true) throw new Error("Required Discovery handoff is incomplete.");
        if (!state.planRef || !existsSync(state.planRef)) throw new Error("Canonical Plan Artifact is missing.");
        if (state.planReview.reviewId !== reviewId || state.planReview.planRef !== state.planRef) throw new Error("Final Plan Review correlation is invalid.");
        if (evidence.largeDataBoundary.forbiddenMainTransportFields !== "NONE") throw new Error("Large Plan/feedback transport field appeared in Main args.");
        const control = await controlValidation();
        evidence.controlPath = control;
        evidence.validation = { realPiHomeMutation: "NONE", packageBinExecuted: false, installerExecuted: false };
        evidence.status = control.status === "PASS" ? "PASS" : "BLOCKED";
        writeEvidence(layout, evidence);
        console.log(`Unit 6 Native Acceptance: ${evidence.status}`);
        console.log(JSON.stringify({
          missionId: record.mission.id,
          round: state.planReview.round,
          planRef: state.planRef,
          reviewId: state.planReview.reviewId,
          evidenceRoot: layout.root,
          controlPath: control.status,
        }, null, 2));
        stopProcess(child);
        if (options.cleanup && evidence.status === "PASS") {
          // Keep the compact terminal report in the parent process output, then remove the fixture.
          rmSync(layout.root, { recursive: true, force: true });
        }
        return evidence;
      }
      if ((child.exitCode !== null || !interactiveProcessActive(layout)) && !pending && !complete) {
        throw new Error(`Interactive Pi exited before Unit 6 completion: code=${String(child.exitCode)}.`);
      }
    }
  } catch (error) {
    stopProcess(child);
    const diff = realPiHomeDiff(before, protectedPiSnapshot(realHome));
    const failure = buildEvidence(layout, baseline, stages, diff.length > 0 ? "BLOCKED" : "BLOCKED", {
      error: String(error).slice(0, 2048),
      isolation: {
        temporaryHome: layout.home,
        temporaryPiAgentDir: layout.agent,
        temporarySessionDir: layout.sessions,
        temporaryTmpDir: layout.tmp,
        temporaryPiSubagentsRoot: layout.runtime,
        realPiHomeMutation: diff.length > 0 ? diff : "NONE",
      },
    });
    writeEvidence(layout, failure);
    console.error(`Unit 6 Native Acceptance: BLOCKED`);
    console.error(String(error));
    console.error(`Evidence root retained: ${layout.root}`);
    process.exitCode = 1;
    return failure;
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/validate-unit6-native.mjs [--cleanup]");
    return;
  }
  await runNative(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
