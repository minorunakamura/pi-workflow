import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 64 * 1024;
const FORCE_KILL_DELAY_MS = 1_000;

export type VerificationCommandStatus = "passed" | "failed" | "unavailable";

export type VerificationCommandRunnerInput = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}>;

export type VerificationCommandRunnerResult = Readonly<{
  status: VerificationCommandStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated: boolean;
  reason?: string;
}>;

function appendOutput(
  current: string,
  chunk: Buffer | string,
): Readonly<{ value: string; truncated: boolean }> {
  const value = `${current}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk}`;
  if (Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES) {
    return { value, truncated: false };
  }
  const suffix = "\n[output truncated]";
  const max = MAX_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8");
  let bytes = 0;
  let prefix = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > max) break;
    prefix += character;
    bytes += size;
  }
  return { value: `${prefix}${suffix}`, truncated: true };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function terminateProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may already have exited or may not have a process group.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The close/error event remains authoritative for the result.
  }
}

/** Executes a pre-parsed verification command without invoking a shell. */
export function runVerificationCommand(
  input: VerificationCommandRunnerInput,
): Promise<VerificationCommandRunnerResult> {
  const startedAt = Date.now();
  if (input.signal?.aborted) {
    return Promise.resolve({
      status: "unavailable",
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      timedOut: false,
      outputTruncated: false,
      reason: "aborted",
    });
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    return Promise.resolve({
      status: "unavailable",
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: Math.max(0, Date.now() - startedAt),
      timedOut: false,
      outputTruncated: false,
      reason: errorMessage(error),
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let stdout = "";
    let stderr = "";
    let outputTruncated = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (result: Omit<VerificationCommandRunnerResult, "durationMs">): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ...result, durationMs: Math.max(0, Date.now() - startedAt) });
    };
    const stop = (kind: "timeout" | "aborted"): void => {
      if (settled) return;
      if (kind === "timeout") timedOut = true;
      else aborted = true;
      terminateProcess(child, "SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!settled) terminateProcess(child, "SIGKILL");
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref?.();
    };
    const onAbort = (): void => stop("aborted");

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const next = appendOutput(stdout, chunk);
      stdout = next.value;
      outputTruncated ||= next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const next = appendOutput(stderr, chunk);
      stderr = next.value;
      outputTruncated ||= next.truncated;
    });
    child.once("error", (error) => {
      finish({
        status: "unavailable",
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        outputTruncated,
        reason: errorCode(error) === "ENOENT" ? "executable-unavailable" : errorMessage(error),
      });
    });
    child.once("close", (exitCode) => {
      if (timedOut || aborted) {
        finish({
          status: "unavailable",
          exitCode: null,
          stdout,
          stderr,
          timedOut,
          outputTruncated,
          reason: timedOut ? "timeout" : "aborted",
        });
        return;
      }
      finish({
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        stdout,
        stderr,
        timedOut: false,
        outputTruncated,
        ...(exitCode === null ? { reason: "process-signal" } : {}),
      });
    });

    if (input.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => stop("timeout"), input.timeoutMs);
      timeoutTimer.unref?.();
    }
    if (input.signal !== undefined) {
      input.signal.addEventListener("abort", onAbort, { once: true });
      if (input.signal.aborted) onAbort();
    }
  });
}
