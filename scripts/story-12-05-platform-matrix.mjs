import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, homedir, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = platform() === "win32" ? "pnpm.cmd" : "pnpm";
const evidenceDirectory = resolve(
  process.env.PI_WORKFLOW_EVIDENCE_DIR ?? join(projectRoot, "release-evidence", "story-12-05"),
);
const evidencePath = join(evidenceDirectory, `${platform()}.json`);
const testLogPath = join(evidenceDirectory, `${platform()}.test.log`);
const packLogPath = join(evidenceDirectory, "pnpm-pack.log");
const installLogPath = join(evidenceDirectory, "pnpm-install.log");
const packedArtifactPath = join(evidenceDirectory, "pi-workflow.tgz");
const testFiles = [
  "tests/integration/file-artifact-store.test.ts",
  "tests/integration/file-state-store.test.ts",
  "tests/integration/file-run-lock.test.ts",
  "tests/integration/file-workspace-lock.test.ts",
  "tests/integration/cross-platform-process-liveness.test.ts",
  "tests/integration/git-repository-adapter.test.ts",
  "tests/e2e/crash-matrix.test.ts",
  "tests/e2e/packed-package-installation.test.ts",
];
const testCommand = `pnpm test ${testFiles.join(" ")}`;

async function commandVersion(command, args) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: projectRoot,
      encoding: "utf8",
    });
    return String(result.stdout).trim();
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function runTests() {
  return new Promise((resolveResult) => {
    const output = [];
    let commandError;
    const child = spawn(pnpm, ["test", ...testFiles], {
      cwd: projectRoot,
      env: { ...process.env, CI: "1", PI_WORKFLOW_EVIDENCE_DIR: evidenceDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const record = (chunk, stream) => {
      const text = String(chunk);
      output.push(text);
      stream.write(text);
    };
    child.stdout?.on("data", (chunk) => record(chunk, process.stdout));
    child.stderr?.on("data", (chunk) => record(chunk, process.stderr));
    child.once("error", (error) => {
      commandError = error;
    });
    child.once("close", (code, signal) => {
      resolveResult({
        code,
        signal,
        error: commandError,
        output: output.join(""),
      });
    });
  });
}

async function main() {
  await mkdir(evidenceDirectory, { recursive: true });
  const testResult = await runTests();
  const testLog = `${testResult.output}${
    testResult.error === undefined ? "" : `\n${testResult.error.message}\n`
  }`;
  await writeFile(testLogPath, testLog, "utf8");

  const result = testResult.code === 0 && testResult.error === undefined ? "PASS" : "FAIL";
  const evidence = {
    OS: platform(),
    "Node version": process.version,
    "pnpm version": await commandVersion(pnpm, ["--version"]),
    "Git version": await commandVersion("git", ["--version"]),
    "filesystem/environment": {
      projectRoot,
      temporaryDirectory: tmpdir(),
      homeDirectory: homedir(),
      pathSeparator: sep,
      architecture: arch(),
      osRelease: release(),
      continuousIntegration: process.env.CI ?? null,
    },
    "test command": testCommand,
    result,
    "artifact/log location": {
      packedArtifact: existsSync(packedArtifactPath) ? packedArtifactPath : null,
      packLog: existsSync(packLogPath) ? packLogPath : null,
      installLog: existsSync(installLogPath) ? installLogPath : null,
      testLog: testLogPath,
      evidence: evidencePath,
    },
    ...(testResult.signal === null ? {} : { signal: testResult.signal }),
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Release Evidence: ${evidencePath}`);

  if (result !== "PASS") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
