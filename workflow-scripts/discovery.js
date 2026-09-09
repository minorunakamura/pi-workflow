const input = __PI_WORKFLOW_INPUT__;

/* pi-workflow: discovery-resource:start */
if (input.resource === "pi-workflow.discovery") {
  const MAX_STATE_BYTES = input.discoveryBounds.stateBytes;
  const MAX_REFERENCE_BYTES = input.discoveryBounds.referenceBytes;
  const MAX_IDENTIFIER_BYTES = input.discoveryBounds.identifierBytes;
  const MAX_REQUEST_BYTES = input.discoveryBounds.requestBytes;
  const MAX_TEXT_BYTES = input.discoveryBounds.textBytes;
  const MAX_HUMAN_INPUTS = input.discoveryBounds.humanInputs;
  const MAX_HUMAN_VALUE_BYTES = input.discoveryBounds.humanValueBytes;
  const MAX_METADATA_BYTES = input.discoveryBounds.metadataBytes;
  const MAX_METADATA_ITEMS = input.discoveryBounds.metadataItems;
  const MAX_JSON_DEPTH = input.discoveryBounds.jsonDepth;
  const requestTypes = ["feature", "bug", "chore", "hotfix"];
  const phases = [
    "discovery",
    "research",
    "planning",
    "plan-review",
    "implementation",
    "verification",
    "verification-fix",
    "review",
  ];
  const missionStatuses = [
    "planned",
    "active",
    "waiting",
    "needs_decision",
    "completed",
    "failed",
    "cancelled",
  ];
  const stateKeys = Array.isArray(input.stateKeys) ? input.stateKeys : [];

  function isRecord(value) {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.prototype.toString.call(value) === "[object Object]"
    );
  }

  function isJsonValue(value, seen) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;

    seen.add(value);
    const valid = Array.isArray(value)
      ? value.every((item) => isJsonValue(item, seen))
      : isRecord(value) && Object.values(value).every((item) => isJsonValue(item, seen));
    seen.delete(value);
    return valid;
  }

  function exceedsDepth(value, depth, seen) {
    if (value === null || typeof value !== "object") return false;
    if (depth > MAX_JSON_DEPTH) return true;
    if (seen.has(value)) return false;

    seen.add(value);
    const values = Array.isArray(value) ? value : Object.values(value);
    const exceeded = values.some((item) => exceedsDepth(item, depth + 1, seen));
    seen.delete(value);
    return exceeded;
  }

  function utf8Bytes(value) {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 0x7f) {
        bytes += 1;
      } else if (code <= 0x7ff) {
        bytes += 2;
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else {
          bytes += 3;
        }
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function jsonBytes(value) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value is not JSON serializable");
    return utf8Bytes(serialized);
  }

  function assertJson(value, label, maximum) {
    if (!isJsonValue(value, new Set())) throw new Error(`${label} must contain JSON values only.`);
    if (exceedsDepth(value, 0, new Set())) throw new Error(`${label} exceeds JSON depth ${MAX_JSON_DEPTH}.`);
    if (maximum !== undefined && jsonBytes(value) > maximum) {
      throw new Error(`${label} exceeds ${maximum} serialized UTF-8 bytes.`);
    }
  }

  function assertText(value, maximum, label) {
    if (typeof value !== "string" || !value) throw new Error(`${label} must be non-empty.`);
    if (utf8Bytes(value) > maximum) {
      throw new Error(`${label} exceeds ${maximum} UTF-8 bytes.`);
    }
  }

  function assertReference(value, label) {
    assertText(value, MAX_REFERENCE_BYTES, label);
    if (jsonBytes(value) > MAX_REFERENCE_BYTES) {
      throw new Error(`${label} exceeds ${MAX_REFERENCE_BYTES} serialized UTF-8 bytes.`);
    }
  }

  function assertExactKeys(value, required, label) {
    const keys = Object.keys(value);
    if (keys.length !== required.length || required.some((key) => !keys.includes(key))) {
      throw new Error(`${label} contains unknown or missing fields.`);
    }
  }

  function assertMetadata(value) {
    if (!isRecord(value)) throw new Error("Discovery metadata must be an object.");
    assertExactKeys(
      value,
      [
        "version",
        "status",
        "externalResearchRequired",
        "humanClarificationRequired",
        "uncertainties",
        "researchQuestions",
      ],
      "Discovery metadata",
    );
    if (value.version !== 1) throw new Error("Discovery metadata version must be 1.");
    if (value.status !== "ready" && value.status !== "blocked") {
      throw new Error("Discovery metadata status is invalid.");
    }
    if (typeof value.externalResearchRequired !== "boolean") {
      throw new Error("Discovery metadata externalResearchRequired must be boolean.");
    }
    if (typeof value.humanClarificationRequired !== "boolean") {
      throw new Error("Discovery metadata humanClarificationRequired must be boolean.");
    }
    if (!Array.isArray(value.uncertainties) || value.uncertainties.length > MAX_METADATA_ITEMS) {
      throw new Error("Discovery metadata uncertainties exceed the bound.");
    }
    value.uncertainties.forEach((item, index) => {
      if (!isRecord(item)) throw new Error(`Discovery uncertainty ${index} must be an object.`);
      assertExactKeys(item, ["id", "question", "material"], `Discovery uncertainty ${index}`);
      assertText(item.id, MAX_IDENTIFIER_BYTES, `Discovery uncertainty ${index} id`);
      assertReference(item.id, `Discovery uncertainty ${index} id`);
      assertText(item.question, MAX_TEXT_BYTES, `Discovery uncertainty ${index} question`);
      if (typeof item.material !== "boolean") {
        throw new Error(`Discovery uncertainty ${index} material must be boolean.`);
      }
    });
    if (!Array.isArray(value.researchQuestions) || value.researchQuestions.length > MAX_METADATA_ITEMS) {
      throw new Error("Discovery metadata researchQuestions exceed the bound.");
    }
    value.researchQuestions.forEach((question, index) => {
      assertText(question, MAX_TEXT_BYTES, `Discovery research question ${index}`);
    });
    assertJson(value, "Discovery metadata", MAX_METADATA_BYTES);
  }

  function assertHumanInputs(value) {
    if (!Array.isArray(value) || value.length > MAX_HUMAN_INPUTS) {
      throw new Error("Mission humanDecisions exceed the bound.");
    }
    value.forEach((item, index) => {
      if (!isRecord(item)) throw new Error(`Mission humanDecisions[${index}] must be an object.`);
      assertExactKeys(item, ["id", "value"], `Mission humanDecisions[${index}]`);
      assertText(item.id, MAX_IDENTIFIER_BYTES, `Mission humanDecisions[${index}] id`);
      assertText(item.value, MAX_HUMAN_VALUE_BYTES, `Mission humanDecisions[${index}] value`);
    });
  }

  function matchesSchema(value, schema) {
    if (!isRecord(schema)) return false;
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some((item) => matchesSchema(value, item))) {
      return false;
    }
    if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
    if (schema.type === "string" && typeof value !== "string") return false;
    if (schema.type === "boolean" && typeof value !== "boolean") return false;
    if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return false;
    if (schema.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) return false;
    if (schema.type === "array") {
      if (!Array.isArray(value)) return false;
      if (schema.minItems !== undefined && value.length < schema.minItems) return false;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
      if (schema.items !== undefined && !value.every((item) => matchesSchema(item, schema.items))) return false;
    }
    if (schema.type === "object") {
      if (!isRecord(value)) return false;
      if (Array.isArray(schema.required) && schema.required.some((key) => !Object.hasOwn(value, key))) return false;
      if (schema.additionalProperties === false && Object.keys(value).some((key) => !Object.hasOwn(schema.properties || {}, key))) return false;
      if (isRecord(schema.properties) && Object.entries(value).some(([key, item]) => schema.properties[key] !== undefined && !matchesSchema(item, schema.properties[key]))) return false;
    }
    if (schema.type === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength) return false;
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return false;
    }
    if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") {
      if (schema.minimum !== undefined && value < schema.minimum) return false;
      if (schema.maximum !== undefined && value > schema.maximum) return false;
    }
    return true;
  }

  function assertMissionState(value, requireVersion) {
    if (!isRecord(value)) throw new Error("Mission state must be an object.");
    assertJson(value, "Mission state", MAX_STATE_BYTES);
    const schemaValue =
      !requireVersion && value.version === undefined
        ? { ...value, version: 1 }
        : value;
    if (!matchesSchema(schemaValue, input.missionStateSchema)) {
      throw new Error("Mission state does not match the package-owned schema.");
    }
    for (const key of Object.keys(value)) {
      if (!stateKeys.includes(key)) throw new Error(`Mission state key '${key}' is not allowed.`);
    }
    if (value.version === undefined) {
      if (requireVersion) throw new Error("Mission state version is required.");
    } else if (value.version !== 1) {
      throw new Error("Mission state version must be 1.");
    }
    if (value.requestType !== undefined && !requestTypes.includes(value.requestType)) {
      throw new Error("Mission state requestType is invalid.");
    }
    if (value.request !== undefined) assertText(value.request, MAX_REQUEST_BYTES, "Mission state request");
    if (value.phase !== undefined && !phases.includes(value.phase)) {
      throw new Error("Mission state phase is invalid.");
    }
    if (value.missionStatus !== undefined && !missionStatuses.includes(value.missionStatus)) {
      throw new Error("Mission state missionStatus is invalid.");
    }
    if (value.humanDecisions !== undefined) assertHumanInputs(value.humanDecisions);
    for (const key of ["discoveryRef", "researchRef", "planRef", "verificationRef"]) {
      if (value[key] !== undefined) assertReference(value[key], `Mission state ${key}`);
    }
    if (value.discoveryMeta !== undefined) assertMetadata(value.discoveryMeta);
  }

  const existingState = {};
  for (const key of stateKeys) {
    const value = await state.get(key);
    if (value !== undefined) existingState[key] = value;
  }
  for (const key of ["discovery", "report", "artifactBody"]) {
    if ((await state.get(key)) !== undefined) {
      throw new Error(`Mission contains unsupported Discovery state '${key}'.`);
    }
  }
  assertMissionState(existingState, false);

  if (
    existingState.requestType !== undefined &&
    existingState.requestType !== input.requestType
  ) {
    throw new Error("Discovery requestType does not match the current Mission.");
  }
  if (
    existingState.request !== undefined &&
    existingState.request !== input.request
  ) {
    throw new Error("Discovery request does not match the current Mission.");
  }
  const hasExistingRef = existingState.discoveryRef !== undefined;
  const hasExistingMetadata = existingState.discoveryMeta !== undefined;
  if (hasExistingRef !== hasExistingMetadata) {
    throw new Error("Mission has an incomplete Discovery handoff.");
  }
  if (hasExistingRef) {
    throw new Error("Mission already contains a Discovery handoff.");
  }

  const artifactResult = await runs.run("discovery-artifact", {
    agent: "scout",
    context: "fresh",
    async: false,
    task: [
      "Inspect the current repository for the requested change.",
      "Request type: " + input.requestType,
      "Request:\n" + input.request,
      "",
      "Discovery policy:",
      "1. Run `codegraph status` first when the CodeGraph CLI is available.",
      "2. If CodeGraph is usable, use `codegraph explore` for structural questions.",
      "3. Read exact source only where CodeGraph is stale, changed on disk, or insufficient.",
      "4. If CodeGraph is unavailable or unusable, use bounded read, grep, find, and ls inspection.",
      "5. Never run codegraph init, index, sync, or upgrade.",
      "",
      "Do not modify repository source files.",
      "Return the complete Discovery report as prose. Include relevant entry points, data/control flow, affected tests, change blast radius, repository constraints, risks, uncertainties, and external research questions.",
    ].join("\n"),
    output: "discovery.md",
    outputMode: "file-only",
  });

  if (!artifactResult || artifactResult.ok !== true) {
    throw new Error(artifactResult?.error || "Discovery scout failed.");
  }
  if (artifactResult.stopped || artifactResult.detached || artifactResult.interrupted) {
    throw new Error("Discovery scout did not complete in the foreground.");
  }
  if (artifactResult.structuredOutput !== undefined) {
    throw new Error("Full Discovery must not use structured output.");
  }
  assertText(artifactResult.runId, MAX_IDENTIFIER_BYTES, "Discovery runId");
  assertReference(artifactResult.outputReference, "Discovery outputReference");

  const metadataResult = await runs.run("discovery-metadata", {
    agent: "scout",
    context: "fresh",
    async: false,
    task: [
      "Read the full Discovery Artifact from this native output reference.",
      "Artifact reference:\n" + artifactResult.outputReference,
      "Do not inspect the repository again and do not modify files.",
      "Extract only the bounded orchestration metadata needed by Main.",
      "Return exactly version, status, externalResearchRequired, humanClarificationRequired, uncertainties, and researchQuestions.",
    ].join("\n"),
    outputSchema: input.discoveryMetadataSchema,
    output: "discovery-metadata.json",
    outputMode: "file-only",
  });

  if (!metadataResult || metadataResult.ok !== true) {
    throw new Error(metadataResult?.error || "Discovery metadata normalization failed.");
  }
  if (metadataResult.stopped || metadataResult.detached || metadataResult.interrupted) {
    throw new Error("Discovery metadata normalization did not complete in the foreground.");
  }
  if (metadataResult.structuredOutput === undefined) {
    throw new Error("Discovery metadata was not returned as structured output.");
  }
  assertMetadata(metadataResult.structuredOutput);

  const nextState = {
    ...existingState,
    version: existingState.version === undefined ? 1 : existingState.version,
    requestType: existingState.requestType === undefined
      ? input.requestType
      : existingState.requestType,
    request: existingState.request === undefined ? input.request : existingState.request,
    discoveryRef: artifactResult.outputReference,
    discoveryMeta: metadataResult.structuredOutput,
    phase: "discovery",
  };
  assertMissionState(nextState, true);

  for (const key of [
    "version",
    "requestType",
    "request",
    "discoveryRef",
    "discoveryMeta",
    "phase",
  ]) {
    if (existingState[key] !== nextState[key]) await state.set(key, nextState[key]);
  }

  const compactResult = {
    status: metadataResult.structuredOutput.status === "ready" ? "completed" : "blocked",
    runId: artifactResult.runId,
    discoveryRef: artifactResult.outputReference,
    discoveryMeta: metadataResult.structuredOutput,
  };
  assertJson(compactResult, "Discovery result", input.discoveryBounds.resultBytes);
  return compactResult;
}
/* pi-workflow: discovery-resource:end */

await state.set("phase", "discovery");

const task = [
  "Inspect the current repository for the requested change.",
  "Request:\n" + input.task,
  "",
  "Discovery policy:",
  "1. Run `codegraph status` first when the CodeGraph CLI is available.",
  "2. If CodeGraph is usable, use `codegraph explore` for structural questions.",
  "3. Read exact source only where CodeGraph is stale, changed on disk, or insufficient.",
  "4. If CodeGraph is unavailable or unusable, use bounded read, grep, find, and ls inspection.",
  "5. Never run codegraph init, index, sync, or upgrade.",
  "",
  "Do not modify repository source files.",
  "Return only a DiscoveryResultV1 object matching the supplied outputSchema.",
].join("\n");

const result = await runs.run("discovery", {
  agent: "scout",
  context: "fresh",
  async: false,
  task,
  outputSchema: input.outputSchema,
  ...(input.outputPath === undefined
    ? {}
    : { output: input.outputPath, outputMode: "file-only" }),
});

if (!result.ok) throw new Error(result.error ?? "Discovery failed.");
if (result.structuredOutput === undefined || result.structuredOutput === null) {
  throw new Error("Discovery did not return structured output.");
}
if (!result.runId) throw new Error("Discovery did not return a runId.");

const discovery = {
  runId: result.runId,
  outputReference: result.outputReference ?? null,
  result: result.structuredOutput,
};
await state.set("discovery", discovery);
return {
  runId: discovery.runId,
  outputReference: discovery.outputReference,
  discovery: discovery.result,
};
