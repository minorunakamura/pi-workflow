import type {
  AgentExecutionRequestV1,
  JsonObject,
  JsonValue,
} from "../contracts/execution/agent-execution.js";
import type { AgentRuntime } from "../ports/agent-runtime.js";
import { redactSecrets } from "./redaction.js";

export const TELEMETRY_LEVELS = ["minimal", "standard", "debug"] as const;
export type TelemetryLevel = (typeof TELEMETRY_LEVELS)[number];
export const DEFAULT_TELEMETRY_LEVEL: TelemetryLevel = "standard";

export type RuntimeTelemetryUsage = Readonly<{
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  cost?: number;
  executionMs?: number;
  toolCalls?: number;
  toolSumMs?: number;
}>;

export type RuntimeTelemetryCaptureOptions = Readonly<{
  level?: TelemetryLevel;
  wallClockMs?: number;
  activeWallMs?: number;
  blockedMs?: number;
  executionSumMs?: number;
  usage?: RuntimeTelemetryUsage;
  model?: JsonValue;
  toolCount?: number;
  toolsUsed?: readonly string[];
  skillsUsed?: readonly string[];
}>;

export type RuntimeTelemetry = JsonObject &
  Readonly<{
    telemetry_level: TelemetryLevel;
  }>;

export type RuntimeTelemetryAttachOptions = Readonly<{
  level?: TelemetryLevel;
  debug?: JsonObject;
}>;

export type TelemetryClock = () => number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function level(value: unknown, fallback = DEFAULT_TELEMETRY_LEVEL): TelemetryLevel {
  if (value === undefined) return fallback;
  if ((TELEMETRY_LEVELS as readonly unknown[]).includes(value)) {
    return value as TelemetryLevel;
  }
  const display = typeof value === "string" ? value : (JSON.stringify(value) ?? typeof value);
  throw new Error(`Unsupported telemetry level: ${display}`);
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNonNegative(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : undefined;
}

function milliseconds(value: unknown): number | undefined {
  const number = finiteNonNegative(value);
  return number === undefined ? undefined : Math.round(number);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function redactedJson(value: JsonObject): JsonObject;
function redactedJson(value: JsonValue): JsonValue;
function redactedJson(value: JsonValue): JsonValue {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [redactSecrets(key), redactedJson(entry)]),
    );
  }
  return value;
}

function redactedObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? redactedJson(value) : undefined;
}

function modelValue(value: unknown): JsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const model = redactSecrets(value.trim());
    return model.length === 0 ? undefined : model;
  }
  if (!isRecord(value)) return undefined;

  const model: Record<string, JsonValue> = {};
  for (const key of ["provider", "model"] as const) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim().length > 0) {
      model[key] = redactSecrets(entry.trim());
    }
  }
  return Object.keys(model).length === 0 ? undefined : model;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0) continue;
    const redacted = redactSecrets(value.trim());
    if (seen.has(redacted)) continue;
    seen.add(redacted);
    result.push(redacted);
  }
  return result;
}

function selectedTools(request: AgentExecutionRequestV1): readonly string[] {
  return uniqueStrings(
    request.tools.resolved.filter((value): value is string => typeof value === "string"),
  );
}

function selectedSkills(request: AgentExecutionRequestV1): readonly JsonValue[] {
  return [...request.skills.required, ...request.skills.optional].map(({ id, version }) => ({
    id: redactSecrets(id),
    version: redactSecrets(version),
  }));
}

function manifestMetric(manifest: JsonObject, ...keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = nonNegativeInteger(manifest[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function addNumber(
  target: Record<string, JsonValue>,
  key: string,
  value: unknown,
  kind: "integer" | "milliseconds" | "number" = "number",
): void {
  const normalized =
    kind === "integer"
      ? nonNegativeInteger(value)
      : kind === "milliseconds"
        ? milliseconds(value)
        : finiteNonNegative(value);
  if (normalized !== undefined) target[key] = normalized;
}

function normalizeTelemetry(
  input: unknown,
  fallbackLevel: TelemetryLevel,
  forcedLevel?: TelemetryLevel,
): RuntimeTelemetry | undefined {
  if (!isRecord(input)) return undefined;
  const telemetryLevel = forcedLevel ?? level(input.telemetry_level, fallbackLevel);
  const result: Record<string, JsonValue> = { telemetry_level: telemetryLevel };

  addNumber(result, "wall_clock_ms", input.wall_clock_ms, "milliseconds");
  addNumber(result, "active_wall_ms", input.active_wall_ms, "milliseconds");
  addNumber(result, "blocked_ms", input.blocked_ms, "milliseconds");
  addNumber(result, "execution_sum_ms", input.execution_sum_ms, "milliseconds");
  addNumber(result, "tool_sum_ms", input.tool_sum_ms, "milliseconds");
  addNumber(result, "input_tokens", input.input_tokens, "integer");
  addNumber(result, "output_tokens", input.output_tokens, "integer");
  addNumber(result, "tokens", input.tokens, "integer");
  addNumber(result, "cached_input_tokens", input.cached_input_tokens, "integer");
  addNumber(result, "reasoning_tokens", input.reasoning_tokens, "integer");
  addNumber(result, "cost", input.cost);

  if (telemetryLevel !== "minimal") {
    const requestedModel = modelValue(input.model_requested);
    const actualModel = modelValue(input.model_actual);
    if (requestedModel !== undefined) result.model_requested = requestedModel;
    if (actualModel !== undefined) result.model_actual = actualModel;

    if (Array.isArray(input.tools_selected)) {
      result.tools_selected = uniqueStrings(
        input.tools_selected.filter((value): value is string => typeof value === "string"),
      );
    }
    if (Array.isArray(input.tools_used)) {
      result.tools_used = uniqueStrings(
        input.tools_used.filter((value): value is string => typeof value === "string"),
      );
    }
    addNumber(result, "tool_calls", input.tool_calls, "integer");

    if (Array.isArray(input.skills_selected)) {
      result.skills_selected = input.skills_selected.flatMap((value) => {
        if (!isRecord(value)) return [];
        const id = typeof value.id === "string" ? redactSecrets(value.id.trim()) : undefined;
        const version =
          typeof value.version === "string" ? redactSecrets(value.version.trim()) : undefined;
        return id && version ? [{ id, version }] : [];
      });
    }
    if (Array.isArray(input.skills_used)) {
      result.skills_used = uniqueStrings(
        input.skills_used.filter((value): value is string => typeof value === "string"),
      );
    }

    for (const [key, value] of [
      ["pack_tokens_estimated_total", input.pack_tokens_estimated_total],
      ["pack_tokens_estimated_peak", input.pack_tokens_estimated_peak],
      ["trim_count", input.trim_count],
      ["budget_exceeded_count", input.budget_exceeded_count],
      ["required_context_missing_count", input.required_context_missing_count],
    ] as const) {
      addNumber(result, key, value, "integer");
    }
  }

  return result as RuntimeTelemetry;
}

function mergeArrays(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): JsonValue | undefined {
  if (!Array.isArray(left)) return right;
  if (!Array.isArray(right)) return left;
  const result: JsonValue[] = [];
  const seen = new Set<string>();
  for (const value of [...left, ...right]) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function mergeTelemetry(
  existing: unknown,
  incoming: RuntimeTelemetry,
  forcedLevel?: TelemetryLevel,
): RuntimeTelemetry {
  const incomingLevel = level(incoming.telemetry_level);
  const existingTelemetry = (() => {
    try {
      return normalizeTelemetry(existing, incomingLevel);
    } catch {
      return undefined;
    }
  })();
  const selectedLevel = forcedLevel ?? existingTelemetry?.telemetry_level ?? incomingLevel;
  const current = normalizeTelemetry(existingTelemetry, selectedLevel, selectedLevel);
  const next = normalizeTelemetry(incoming, selectedLevel, selectedLevel) ?? {
    telemetry_level: selectedLevel,
  };
  const result: Record<string, JsonValue> = { ...next };
  if (current !== undefined) Object.assign(result, current);
  result.telemetry_level = selectedLevel;

  for (const key of ["tools_selected", "tools_used", "skills_selected", "skills_used"] as const) {
    const merged = mergeArrays(current?.[key], next[key]);
    if (merged !== undefined) result[key] = merged;
  }
  return result as RuntimeTelemetry;
}

/** Builds compact execution telemetry from request metadata and provider observations. */
export function captureRuntimeTelemetry(
  request: AgentExecutionRequestV1,
  options: RuntimeTelemetryCaptureOptions = {},
): RuntimeTelemetry {
  const telemetryLevel = level(options.level);
  const usage = options.usage;
  const wallClockMs = milliseconds(options.wallClockMs ?? usage?.executionMs);
  const executionSumMs = milliseconds(
    options.executionSumMs ?? usage?.executionMs ?? options.wallClockMs,
  );
  const result: Record<string, JsonValue> = { telemetry_level: telemetryLevel };

  addNumber(result, "wall_clock_ms", wallClockMs, "milliseconds");
  addNumber(result, "active_wall_ms", options.activeWallMs ?? wallClockMs, "milliseconds");
  addNumber(result, "blocked_ms", options.blockedMs, "milliseconds");
  addNumber(result, "execution_sum_ms", executionSumMs, "milliseconds");
  addNumber(result, "tool_sum_ms", usage?.toolSumMs, "milliseconds");
  addNumber(result, "input_tokens", usage?.inputTokens, "integer");
  addNumber(result, "output_tokens", usage?.outputTokens, "integer");
  addNumber(result, "tokens", usage?.totalTokens, "integer");
  addNumber(result, "cached_input_tokens", usage?.cachedInputTokens, "integer");
  addNumber(result, "reasoning_tokens", usage?.reasoningTokens, "integer");
  addNumber(result, "cost", usage?.cost);

  if (telemetryLevel !== "minimal") {
    const requestedModel = modelValue(request.model.requested);
    const actualModel = modelValue(options.model ?? request.model.actual);
    if (requestedModel !== undefined) result.model_requested = redactedJson(requestedModel);
    if (actualModel !== undefined) result.model_actual = redactedJson(actualModel);
    result.tools_selected = selectedTools(request);
    result.skills_selected = selectedSkills(request);

    if (options.toolsUsed !== undefined) result.tools_used = uniqueStrings(options.toolsUsed);
    addNumber(result, "tool_calls", usage?.toolCalls ?? options.toolCount, "integer");

    const manifest = request.context.manifest;
    const total = manifestMetric(
      manifest,
      "pack_tokens_estimated_total",
      "estimatedTokenSize",
      "estimated_token_size",
    );
    const peak = manifestMetric(
      manifest,
      "pack_tokens_estimated_peak",
      "estimatedTokenPeak",
      "estimated_token_peak",
    );
    addNumber(result, "pack_tokens_estimated_total", total, "integer");
    addNumber(result, "pack_tokens_estimated_peak", peak ?? total, "integer");
    addNumber(result, "trim_count", manifestMetric(manifest, "trim_count", "trimCount"), "integer");
    addNumber(
      result,
      "budget_exceeded_count",
      manifestMetric(manifest, "budget_exceeded_count", "budgetExceededCount"),
      "integer",
    );
    addNumber(
      result,
      "required_context_missing_count",
      manifestMetric(manifest, "required_context_missing_count", "requiredContextMissingCount"),
      "integer",
    );
    if (options.skillsUsed !== undefined) result.skills_used = uniqueStrings(options.skillsUsed);
  }

  return normalizeTelemetry(result, telemetryLevel, telemetryLevel) as RuntimeTelemetry;
}

/** Adds allowlisted telemetry and debug-only diagnostics without copying prompt/tool payloads. */
export function attachRuntimeTelemetry<T>(
  result: T,
  telemetry: RuntimeTelemetry,
  options: RuntimeTelemetryAttachOptions = {},
): T {
  if (!isRecord(result)) return result;
  const currentRuntime = result.runtime;
  if (currentRuntime !== undefined && !isRecord(currentRuntime)) return result;

  const runtime = (currentRuntime ?? {}) as Record<string, unknown>;
  const mergedTelemetry = mergeTelemetry(runtime.telemetry, telemetry, options.level);
  const telemetryLevel = options.level ?? mergedTelemetry.telemetry_level;
  const currentDebug = redactedObject(runtime.debug);
  const debug =
    telemetryLevel === "debug" && (currentDebug !== undefined || options.debug !== undefined)
      ? Object.assign(
          {},
          currentDebug,
          options.debug === undefined ? undefined : redactedJson(options.debug),
        )
      : undefined;
  const { debug: _discardedDebug, ...runtimeWithoutDebug } = runtime;
  return {
    ...result,
    runtime: {
      ...runtimeWithoutDebug,
      ...(debug === undefined ? {} : { debug }),
      telemetry: mergedTelemetry,
    },
  } as T;
}

/** Returns the redacted, compact telemetry portion safe for a standard Event. */
export function persistedRuntimeTelemetry(runtime: unknown): JsonObject | undefined {
  if (!isRecord(runtime)) return undefined;
  try {
    return normalizeTelemetry(runtime.telemetry, DEFAULT_TELEMETRY_LEVEL);
  } catch {
    return undefined;
  }
}

function elapsed(start: number | undefined, end: number | undefined): number | undefined {
  if (start === undefined || end === undefined) return undefined;
  return milliseconds(end - start);
}

function clockValue(clock: TelemetryClock): number | undefined {
  try {
    const value = clock();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export type TelemetryAgentRuntimeOptions = Readonly<{
  level?: TelemetryLevel;
  now?: TelemetryClock;
}>;

/** Instruments any AgentRuntime at the execution boundary with compact telemetry. */
export class TelemetryAgentRuntime implements AgentRuntime {
  private readonly clock: TelemetryClock;

  constructor(
    private readonly delegate: AgentRuntime,
    private readonly options: TelemetryAgentRuntimeOptions = {},
  ) {
    this.clock = options.now ?? (() => performance.now());
  }

  async run(request: AgentExecutionRequestV1, signal?: AbortSignal): Promise<unknown> {
    const started = clockValue(this.clock);
    const result = await this.delegate.run(request, signal);
    const wallClockMs = elapsed(started, clockValue(this.clock));
    const telemetry = captureRuntimeTelemetry(request, {
      ...(this.options.level === undefined ? {} : { level: this.options.level }),
      ...(wallClockMs === undefined ? {} : { wallClockMs }),
    });
    return attachRuntimeTelemetry(
      result,
      telemetry,
      this.options.level === undefined ? {} : { level: this.options.level },
    );
  }
}

export function withRuntimeTelemetry(
  runtime: AgentRuntime,
  options: TelemetryAgentRuntimeOptions = {},
): AgentRuntime {
  return new TelemetryAgentRuntime(runtime, options);
}
