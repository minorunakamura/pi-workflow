const input = __PI_WORKFLOW_INPUT__;

/* pi-workflow: research-resource:start */
if (input.resource === "pi-workflow.research") {
  const MAX_STATE_BYTES = input.researchBounds.stateBytes;
  const MAX_REFERENCE_BYTES = input.researchBounds.referenceBytes;
  const MAX_IDENTIFIER_BYTES = input.researchBounds.identifierBytes;
  const MAX_TEXT_BYTES = input.researchBounds.textBytes;
  const MAX_METADATA_BYTES = input.researchBounds.metadataBytes;
  const MAX_METADATA_ITEMS = input.researchBounds.metadataItems;
  const MAX_JSON_DEPTH = input.researchBounds.jsonDepth;
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
    if (utf8Bytes(value) > maximum) throw new Error(`${label} exceeds ${maximum} UTF-8 bytes.`);
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

  function assertDiscoveryMetadata(value) {
    if (!matchesSchema(value, input.discoveryMetadataSchema)) {
      throw new Error("Mission discoveryMeta does not match the package-owned schema.");
    }
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
    value.uncertainties.forEach((item, index) => {
      assertText(item.id, MAX_IDENTIFIER_BYTES, `Discovery uncertainty ${index} id`);
      assertReference(item.id, `Discovery uncertainty ${index} id`);
      assertText(item.question, MAX_TEXT_BYTES, `Discovery uncertainty ${index} question`);
    });
    value.researchQuestions.forEach((question, index) => {
      assertText(question, MAX_TEXT_BYTES, `Discovery research question ${index}`);
    });
    assertJson(value, "Discovery metadata", MAX_METADATA_BYTES);
  }

  function assertResearchMetadata(value) {
    if (!matchesSchema(value, input.researchMetadataSchema)) {
      throw new Error("Research metadata does not match the package-owned schema.");
    }
    assertExactKeys(value, ["version", "status", "unresolvedQuestions"], "Research metadata");
    if (value.unresolvedQuestions.length > MAX_METADATA_ITEMS) {
      throw new Error("Research metadata unresolvedQuestions exceed the bound.");
    }
    value.unresolvedQuestions.forEach((question, index) => {
      assertText(question, MAX_TEXT_BYTES, `Research unresolved question ${index}`);
    });
    assertJson(value, "Research metadata", MAX_METADATA_BYTES);
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
    if (value.version !== undefined && value.version !== 1) {
      throw new Error("Mission state version must be 1.");
    }
    if (value.version === undefined && requireVersion) {
      throw new Error("Mission state version is required.");
    }
    if (value.requestType !== undefined && !requestTypes.includes(value.requestType)) {
      throw new Error("Mission state requestType is invalid.");
    }
    if (value.request !== undefined) assertText(value.request, input.researchBounds.requestBytes, "Mission state request");
    if (value.phase !== undefined && !phases.includes(value.phase)) {
      throw new Error("Mission state phase is invalid.");
    }
    if (value.missionStatus !== undefined && !missionStatuses.includes(value.missionStatus)) {
      throw new Error("Mission state missionStatus is invalid.");
    }
    for (const key of ["discoveryRef", "researchRef", "planRef", "verificationRef"]) {
      if (value[key] !== undefined) assertReference(value[key], `Mission state ${key}`);
    }
    if (value.discoveryMeta !== undefined) assertDiscoveryMetadata(value.discoveryMeta);
    if (value.researchMeta !== undefined) assertResearchMetadata(value.researchMeta);
  }

  const existingState = {};
  for (const key of stateKeys) {
    const value = await state.get(key);
    if (value !== undefined) existingState[key] = value;
  }
  for (const key of ["discovery", "research", "report", "artifactBody"]) {
    if ((await state.get(key)) !== undefined) {
      throw new Error(`Mission contains unsupported Research state '${key}'.`);
    }
  }
  assertMissionState(existingState, false);

  const discoveryRef = existingState.discoveryRef;
  const discoveryMeta = existingState.discoveryMeta;
  if (discoveryRef === undefined) throw new Error("Research requires discoveryRef from the same Mission.");
  if (discoveryMeta === undefined) throw new Error("Research requires discoveryMeta from the same Mission.");
  assertReference(discoveryRef, "Research discoveryRef");
  assertDiscoveryMetadata(discoveryMeta);

  if (existingState.researchRef !== undefined) {
    throw new Error("Mission already contains a Research handoff.");
  }
  if (
    existingState.researchMeta !== undefined &&
    !(discoveryMeta.externalResearchRequired === false && existingState.researchMeta.status === "skipped")
  ) {
    throw new Error("Mission already contains Research metadata.");
  }

  if (discoveryMeta.externalResearchRequired === false) {
    const researchMeta = existingState.researchMeta || {
      version: 1,
      status: "skipped",
      unresolvedQuestions: [],
    };
    assertResearchMetadata(researchMeta);
    const nextState = {
      ...existingState,
      version: existingState.version === undefined ? 1 : existingState.version,
      researchMeta,
      phase: "research",
    };
    assertMissionState(nextState, true);
    for (const key of ["version", "phase", "researchMeta"]) {
      if (existingState[key] !== nextState[key]) await state.set(key, nextState[key]);
    }
    const compactResult = { status: "skipped", researchMeta };
    assertJson(compactResult, "Research result", input.researchBounds.resultBytes);
    return compactResult;
  }

  const questions = discoveryMeta.researchQuestions.length
    ? "Research questions:\n" + discoveryMeta.researchQuestions.map((question) => "- " + question).join("\n")
    : "Research questions: none supplied.";
  const result = await runs.run("research", {
    agent: "pi-workflow.researcher",
    context: "fresh",
    async: false,
    task: [
      "Use the Discovery Artifact Reference below as the provenance handoff before collecting external evidence.",
      "Discovery Artifact Reference:\n" + discoveryRef,
      "Use only the bounded Discovery questions below as inline context. Do not request or copy the full Artifact body, and do not ask the supervisor to provide it.",
      questions,
      "",
      "Collect external evidence only. Use primary sources when possible.",
      "Remain read-only. Do not make product, architecture, policy, or risk-acceptance decisions.",
      "Return a complete Research report with sources, findings, analysis, evidence, and citations.",
    ].join("\n"),
    output: "research.md",
    outputMode: "file-only",
  });

  if (!result || result.ok !== true) {
    throw new Error(result?.error || "External research failed.");
  }
  if (result.stopped || result.detached || result.interrupted) {
    throw new Error("Researcher did not complete in the foreground.");
  }
  if (result.structuredOutput !== undefined) {
    throw new Error("Full Research must not use structured output.");
  }
  assertText(result.runId, MAX_IDENTIFIER_BYTES, "Research runId");
  assertReference(result.outputReference, "Research outputReference");

  const researchMeta = {
    version: 1,
    status: "completed",
    unresolvedQuestions: [],
  };
  assertResearchMetadata(researchMeta);
  const nextState = {
    ...existingState,
    version: existingState.version === undefined ? 1 : existingState.version,
    researchRef: result.outputReference,
    researchMeta,
    phase: "research",
  };
  assertMissionState(nextState, true);

  for (const key of ["version", "researchRef", "phase", "researchMeta"]) {
    if (existingState[key] !== nextState[key]) await state.set(key, nextState[key]);
  }

  const compactResult = {
    status: "completed",
    runId: result.runId,
    researchRef: result.outputReference,
    researchMeta,
  };
  assertJson(compactResult, "Research result", input.researchBounds.resultBytes);
  return compactResult;
}
/* pi-workflow: research-resource:end */

await state.set("phase", "research");

let questionText = "";
if (input.questions?.length) {
  questionText = "Questions:\n";
  for (const question of input.questions) questionText += "- " + question + "\n";
}

const task = [
  "Collect external evidence needed for the requested change.",
  "Request and research context:\n" + input.task,
  questionText,
  "",
  "Use primary sources when possible.",
  "Return evidence and uncertainty only; do not make product, architecture, policy, or risk-acceptance decisions.",
].join("\n");

const result = await runs.run("research", {
  agent: "pi-workflow.researcher",
  context: "fresh",
  async: false,
  task,
  ...(input.outputPath === undefined
    ? {}
    : { output: input.outputPath, outputMode: "file-only" }),
});

if (!result.ok) throw new Error(result.error ?? "External research failed.");
if (!result.runId) throw new Error("External research did not return a runId.");

const research = {
  runId: result.runId,
  outputReference: result.outputReference ?? null,
};
await state.set("research", research);
return research;
