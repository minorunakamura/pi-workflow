/* pi-workflow: planning-resource:start */
if (input.resource === "pi-workflow.planning") {
  const MAX_STATE_BYTES = input.planningBounds.stateBytes;
  const MAX_REFERENCE_BYTES = input.planningBounds.referenceBytes;
  const MAX_IDENTIFIER_BYTES = input.planningBounds.identifierBytes;
  const MAX_REQUEST_BYTES = input.planningBounds.requestBytes;
  const MAX_TEXT_BYTES = input.planningBounds.textBytes;
  const MAX_COMMAND_BYTES = input.planningBounds.commandBytes;
  const MAX_HUMAN_INPUTS = input.planningBounds.humanInputs;
  const MAX_HUMAN_VALUE_BYTES = input.planningBounds.humanValueBytes;
  const MAX_DECISION_BYTES = input.planningBounds.decisionBytes;
  const MAX_METADATA_BYTES = input.planningBounds.metadataBytes;
  const MAX_METADATA_ITEMS = input.planningBounds.metadataItems;
  const MAX_JSON_DEPTH = input.planningBounds.jsonDepth;
  const requestTypes = ["feature", "bug", "chore", "hotfix"];
  const phases = ["discovery", "research", "planning", "plan-review"];
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
    if (typeof value !== "object" || seen.has(value)) return false;

    seen.add(value);
    const valid = Array.isArray(value)
      ? value.every((item) => isJsonValue(item, seen))
      : isRecord(value) && Object.values(value).every((item) => isJsonValue(item, seen));
    seen.delete(value);
    return valid;
  }

  function exceedsDepth(value, depth, seen) {
    if (value === null || typeof value !== "object") return false;
    if (depth > MAX_JSON_DEPTH || seen.has(value)) return depth > MAX_JSON_DEPTH;

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
      if (code <= 0x7f) bytes += 1;
      else if (code <= 0x7ff) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          bytes += 4;
          index += 1;
        } else bytes += 3;
      } else bytes += 3;
    }
    return bytes;
  }

  function jsonBytes(value) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("value is not JSON serializable");
    return utf8Bytes(serialized);
  }

  function assertJson(value, label, maximum) {
    if (!isJsonValue(value, new Set())) {
      throw new Error(`${label} must contain JSON values only.`);
    }
    if (exceedsDepth(value, 0, new Set())) {
      throw new Error(`${label} exceeds JSON depth ${MAX_JSON_DEPTH}.`);
    }
    if (maximum !== undefined && jsonBytes(value) > maximum) {
      throw new Error(`${label} exceeds ${maximum} serialized UTF-8 bytes.`);
    }
  }

  function assertText(value, maximum, label) {
    if (typeof value !== "string" || !value) {
      throw new Error(`${label} must be non-empty.`);
    }
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

  function assertExactKeys(value, required, label) {
    const keys = Object.keys(value);
    if (keys.length !== required.length || required.some((key) => !keys.includes(key))) {
      throw new Error(`${label} contains unknown or missing fields.`);
    }
  }

  function assertHumanInputs(value, label = "Human decisions") {
    if (!Array.isArray(value) || value.length > MAX_HUMAN_INPUTS) {
      throw new Error(`${label} exceed the bound.`);
    }
    value.forEach((item, index) => {
      if (!isRecord(item)) throw new Error(`${label}[${index}] must be an object.`);
      assertExactKeys(item, ["id", "value"], `${label}[${index}]`);
      assertText(item.id, MAX_IDENTIFIER_BYTES, `${label}[${index}] id`);
      assertText(item.value, MAX_HUMAN_VALUE_BYTES, `${label}[${index}] value`);
    });
  }

  function planningBoundedIssues(value) {
    const issues = [];
    const addText = (path, text) => {
      if (utf8Bytes(text) > MAX_TEXT_BYTES) issues.push({ path, message: `text exceeds ${MAX_TEXT_BYTES} UTF-8 bytes` });
    };
    const addIdentifier = (path, text) => {
      if (utf8Bytes(text) > MAX_IDENTIFIER_BYTES) issues.push({ path, message: `identifier exceeds ${MAX_IDENTIFIER_BYTES} UTF-8 bytes` });
    };
    const addCommand = (path, text) => {
      if (utf8Bytes(text) > MAX_COMMAND_BYTES) issues.push({ path, message: `command or scope exceeds ${MAX_COMMAND_BYTES} UTF-8 bytes` });
    };

    addText("/requestSummary", value.requestSummary);
    for (const [scope, values] of Object.entries(value.scope)) {
      values.forEach((text, index) => addText(`/scope/${scope}/${index}`, text));
    }
    value.acceptanceCriteria.forEach((criterion, index) => {
      addIdentifier(`/acceptanceCriteria/${index}/id`, criterion.id);
      addText(`/acceptanceCriteria/${index}/text`, criterion.text);
    });
    value.constraints.forEach((text, index) => addText(`/constraints/${index}`, text));
    value.risks.forEach((text, index) => addText(`/risks/${index}`, text));
    value.verification.forEach((verification, index) => {
      addIdentifier(`/verification/${index}/id`, verification.id);
      addText(`/verification/${index}/description`, verification.description);
      addCommand(`/verification/${index}/command`, verification.command);
    });
    value.implementation.workUnits.forEach((workUnit, index) => {
      addIdentifier(`/implementation/workUnits/${index}/id`, workUnit.id);
      addText(`/implementation/workUnits/${index}/title`, workUnit.title);
      addText(`/implementation/workUnits/${index}/objective`, workUnit.objective);
      workUnit.dependsOn.forEach((id, idIndex) => addIdentifier(`/implementation/workUnits/${index}/dependsOn/${idIndex}`, id));
      workUnit.writeScope.forEach((path, pathIndex) => addCommand(`/implementation/workUnits/${index}/writeScope/${pathIndex}`, path));
      workUnit.acceptanceCriteriaIds.forEach((id, idIndex) => addIdentifier(`/implementation/workUnits/${index}/acceptanceCriteriaIds/${idIndex}`, id));
      workUnit.focusedVerificationIds.forEach((id, idIndex) => addIdentifier(`/implementation/workUnits/${index}/focusedVerificationIds/${idIndex}`, id));
    });
    value.implementation.finalVerificationIds.forEach((id, index) => addIdentifier(`/implementation/finalVerificationIds/${index}`, id));
    value.unresolvedDecisions.forEach((item, index) => {
      addIdentifier(`/unresolvedDecisions/${index}/id`, item.id);
      addText(`/unresolvedDecisions/${index}/question`, item.question);
      addText(`/unresolvedDecisions/${index}/reason`, item.reason);
    });
    return issues;
  }

  function duplicateIdIssues(items, path, message) {
    const seen = new Set();
    const issues = [];
    items.forEach((item, index) => {
      if (seen.has(item.id)) issues.push({ path: `${path}/${index}/id`, message });
      else seen.add(item.id);
    });
    return issues;
  }

  function missingReferenceIssues(values, path, knownIds, message) {
    const issues = [];
    values.forEach((id, index) => {
      if (!knownIds.has(id)) issues.push({ path: `${path}/${index}`, message: `${message} ${id}` });
    });
    return issues;
  }

  function planningSemanticIssues(value) {
    const issues = [
      ...duplicateIdIssues(value.acceptanceCriteria, "/acceptanceCriteria", "acceptanceCriteria ids must be unique"),
      ...duplicateIdIssues(value.verification, "/verification", "verification ids must be unique"),
      ...duplicateIdIssues(value.implementation.workUnits, "/implementation/workUnits", "work unit ids must be unique"),
      ...duplicateIdIssues(value.unresolvedDecisions, "/unresolvedDecisions", "unresolved decision ids must be unique"),
    ];
    const acceptanceIds = new Set(value.acceptanceCriteria.map((criterion) => criterion.id));
    const verificationIds = new Set(value.verification.map((verification) => verification.id));
    const workUnitIds = new Set(value.implementation.workUnits.map((workUnit) => workUnit.id));

    value.implementation.workUnits.forEach((workUnit, index) => {
      if (workUnit.writeScope.length === 0) {
        issues.push({ path: `/implementation/workUnits/${index}/writeScope`, message: "writeScope must contain at least one path" });
      }
      issues.push(
        ...missingReferenceIssues(workUnit.dependsOn, `/implementation/workUnits/${index}/dependsOn`, workUnitIds, `work unit ${workUnit.id} references unknown dependency`),
        ...missingReferenceIssues(workUnit.acceptanceCriteriaIds, `/implementation/workUnits/${index}/acceptanceCriteriaIds`, acceptanceIds, `work unit ${workUnit.id} references unknown acceptance criterion`),
        ...missingReferenceIssues(workUnit.focusedVerificationIds, `/implementation/workUnits/${index}/focusedVerificationIds`, verificationIds, `work unit ${workUnit.id} references unknown verification`),
      );
      workUnit.dependsOn.forEach((dependency, dependencyIndex) => {
        if (dependency === workUnit.id) {
          issues.push({ path: `/implementation/workUnits/${index}/dependsOn/${dependencyIndex}`, message: "work unit cannot depend on itself" });
        }
      });
    });
    issues.push(...missingReferenceIssues(value.implementation.finalVerificationIds, "/implementation/finalVerificationIds", verificationIds, "final verification references unknown verification"));

    if (value.implementation.mode === "lanes" && value.implementation.workUnits.some((workUnit) => workUnit.dependsOn.length > 0)) {
      issues.push({ path: "/implementation/workUnits", message: "lane mode work units must not depend on another work unit" });
    }
    return issues;
  }

  function planningValidation(value) {
    if (!matchesSchema(value, input.planningDecisionSchema)) {
      return {
        schemaValid: false,
        errors: [{ path: "/", message: "PlanningDecisionV1 does not match the package-owned schema" }],
      };
    }
    const errors = [
      ...planningBoundedIssues(value),
      ...planningSemanticIssues(value),
    ];
    if (jsonBytes(value) > MAX_DECISION_BYTES) {
      errors.push({ path: "/", message: `serialized JSON exceeds ${MAX_DECISION_BYTES} bytes` });
    }
    return { schemaValid: true, errors };
  }

  function validationText(errors) {
    return errors.map((error) => `${error.path}: ${error.message}`).join("\n");
  }

  function assertPlanningDecision(value, label) {
    const validation = planningValidation(value);
    if (!validation.schemaValid || validation.errors.length > 0) {
      throw new Error(`${label} is invalid:\n${validationText(validation.errors)}`);
    }
  }

  function assertDiscoveryMetadata(value) {
    if (!isRecord(value) || !matchesSchema(value, input.missionStateSchema.properties.discoveryMeta)) {
      throw new Error("Mission discoveryMeta does not match the package-owned schema.");
    }
    assertExactKeys(value, [
      "version",
      "status",
      "externalResearchRequired",
      "humanClarificationRequired",
      "uncertainties",
      "researchQuestions",
    ], "Discovery metadata");
    if (value.version !== 1 || value.status !== "ready" && value.status !== "blocked") {
      throw new Error("Mission discoveryMeta has an invalid version or status.");
    }
    if (value.uncertainties.length > MAX_METADATA_ITEMS || value.researchQuestions.length > MAX_METADATA_ITEMS) {
      throw new Error("Mission discoveryMeta exceeds the item bound.");
    }
    value.uncertainties.forEach((item, index) => {
      assertExactKeys(item, ["id", "question", "material"], `Discovery uncertainty ${index}`);
      assertText(item.id, MAX_IDENTIFIER_BYTES, `Discovery uncertainty ${index} id`);
      assertText(item.question, MAX_TEXT_BYTES, `Discovery uncertainty ${index} question`);
      if (typeof item.material !== "boolean") throw new Error(`Discovery uncertainty ${index} material must be boolean.`);
    });
    value.researchQuestions.forEach((question, index) => assertText(question, MAX_TEXT_BYTES, `Discovery research question ${index}`));
    assertJson(value, "Mission discoveryMeta", MAX_METADATA_BYTES);
  }

  function assertResearchMetadata(value) {
    if (!isRecord(value) || !matchesSchema(value, input.missionStateSchema.properties.researchMeta)) {
      throw new Error("Mission researchMeta does not match the package-owned schema.");
    }
    assertExactKeys(value, ["version", "status", "unresolvedQuestions"], "Research metadata");
    if (value.version !== 1 || !["completed", "blocked"].includes(value.status)) {
      throw new Error("Mission researchMeta has an invalid version or status.");
    }
    if (value.unresolvedQuestions.length > MAX_METADATA_ITEMS) throw new Error("Mission researchMeta exceeds the item bound.");
    value.unresolvedQuestions.forEach((question, index) => assertText(question, MAX_TEXT_BYTES, `Research unresolved question ${index}`));
    assertJson(value, "Mission researchMeta", MAX_METADATA_BYTES);
  }

  function assertMissionState(value, requireVersion) {
    if (!isRecord(value)) throw new Error("Mission state must be an object.");
    assertJson(value, "Mission state", MAX_STATE_BYTES);
    const schemaValue = !requireVersion && value.version === undefined ? { ...value, version: 1 } : value;
    if (!matchesSchema(schemaValue, input.missionStateSchema)) throw new Error("Mission state does not match the package-owned schema.");
    for (const key of Object.keys(value)) {
      if (!stateKeys.includes(key)) throw new Error(`Mission state key '${key}' is not allowed.`);
    }
    if (value.version !== undefined && value.version !== 1) throw new Error("Mission state version must be 1.");
    if (value.version === undefined && requireVersion) throw new Error("Mission state version is required.");
    if (value.requestType !== undefined && !requestTypes.includes(value.requestType)) throw new Error("Mission state requestType is invalid.");
    if (value.request !== undefined) assertText(value.request, MAX_REQUEST_BYTES, "Mission state request");
    if (value.phase !== undefined && !phases.includes(value.phase)) throw new Error("Mission state phase is invalid.");
    if (value.humanDecisions !== undefined) assertHumanInputs(value.humanDecisions);
    for (const key of ["discoveryRef", "researchRef", "planRef"]) {
      if (value[key] !== undefined) assertReference(value[key], `Mission state ${key}`);
    }
    if (value.discoveryMeta !== undefined) assertDiscoveryMetadata(value.discoveryMeta);
    if (value.researchMeta !== undefined) assertResearchMetadata(value.researchMeta);
    if (value.planningDecision !== undefined) assertPlanningDecision(value.planningDecision, "Mission planningDecision");
    if (value.planReview !== undefined) assertPlanReviewBinding(value.planReview);
  }

  function assertPlanReviewBinding(value) {
    if (!isRecord(value) || !matchesSchema(value, input.planReviewBindingSchema)) {
      throw new Error("Mission planReview does not match the package-owned schema.");
    }
    const allowedKeys = ["version", "status", "round", "planRef", "reviewId", "feedbackRef"];
    if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
      throw new Error("Mission planReview contains unknown fields.");
    }
    if (value.version !== 1 || !["pending", "approved", "rejected"].includes(value.status)) {
      throw new Error("Mission planReview has an invalid version or status.");
    }
    if (!Number.isInteger(value.round) || value.round < 1 || value.round > input.planningBounds.planReviewRounds) {
      throw new Error("Mission planReview round is invalid.");
    }
    assertReference(value.planRef, "Mission planReview planRef");
    if (value.reviewId !== undefined) assertReference(value.reviewId, "Mission planReview reviewId");
    if (value.feedbackRef !== undefined) assertReference(value.feedbackRef, "Mission planReview feedbackRef");
    if (value.status === "pending" && value.feedbackRef !== undefined) {
      throw new Error("Pending Plan Review must not have a feedbackRef.");
    }
    if (value.status !== "pending" && value.reviewId === undefined) {
      throw new Error("Terminal Plan Review requires a reviewId.");
    }
    if (value.status === "rejected" && value.feedbackRef === undefined) {
      throw new Error("Rejected Plan Review requires a feedbackRef.");
    }
    if (value.status === "approved" && value.feedbackRef !== undefined) {
      throw new Error("Approved Plan Review must not have a feedbackRef.");
    }
    assertJson(value, "Mission planReview", input.planningBounds.planReviewBindingBytes);
  }

  function compactPlanReview(value) {
    assertPlanReviewBinding(value);
    const result = {
      status: value.status,
      round: value.round,
      planRef: value.planRef,
      ...(value.reviewId === undefined ? {} : { reviewId: value.reviewId }),
      ...(value.feedbackRef === undefined ? {} : { feedbackRef: value.feedbackRef }),
    };
    assertJson(result, "Plan Review result", input.planningBounds.resultBytes);
    return result;
  }

  function assertPlanReviewBase(value, planRef, round) {
    if (value.planRef === undefined) throw new Error("Plan Review requires the current Mission planRef.");
    assertReference(value.planRef, "Mission planRef");
    assertReference(planRef, "supplied planRef");
    if (value.planRef !== planRef) throw new Error("Plan Review planRef does not match the current Mission.");
    const preparingReplan =
      value.phase === "planning" &&
      value.planReview !== undefined &&
      value.planReview.status === "pending" &&
      value.planReview.reviewId === undefined &&
      value.planReview.round === round &&
      value.planReview.planRef === planRef;
    if (value.phase !== "plan-review" && !preparingReplan) {
      throw new Error("Plan Review requires the Mission to be in the plan-review phase.");
    }
    if (value.planningDecision === undefined) throw new Error("Plan Review requires the current PlanningDecisionV1.");
    assertPlanningDecision(value.planningDecision, "Mission planningDecision");
    if (value.planningDecision.unresolvedDecisions.length > 0) {
      throw new Error("Plan Review requires all unresolved decisions to be resolved.");
    }
  }

  function readPlanReviewState(value) {
    assertMissionState(value, false);
  }

  const operation = input.operation ?? "plan";
  if (operation !== "plan") {
    const controlState = {};
    for (const key of stateKeys) {
      const value = await state.get(key);
      if (value !== undefined) controlState[key] = value;
    }
    readPlanReviewState(controlState);
    assertPlanReviewBase(controlState, input.planRef, input.round);

    const binding = controlState.planReview;
    if (binding === undefined && input.round !== 1) {
      throw new Error("Plan Review has no current round binding.");
    }
    if (operation === "prepare-review") {
      if (binding === undefined) {
        const pending = {
          version: 1,
          status: "pending",
          round: input.round,
          planRef: input.planRef,
        };
        const nextState = {
          ...controlState,
          version: controlState.version === undefined ? 1 : controlState.version,
          planReview: pending,
        };
        assertMissionState(nextState, true);
        if (controlState.version === undefined) await state.set("version", 1);
        await state.set("planReview", pending);
        return {
          status: "ready",
          round: input.round,
          planRef: input.planRef,
        };
      }

      if (binding.planRef === input.planRef && binding.round === input.round) {
        if (binding.status === "pending" && binding.reviewId === undefined) {
          if (controlState.phase !== "planning") {
            throw new Error("Plan Review has an incomplete pending binding; recovery needs a decision.");
          }
          const nextState = {
            ...controlState,
            version: controlState.version === undefined ? 1 : controlState.version,
            phase: "plan-review",
          };
          assertMissionState(nextState, true);
          if (controlState.version === undefined) await state.set("version", 1);
          await state.set("phase", "plan-review");
          return {
            status: "ready",
            round: input.round,
            planRef: input.planRef,
          };
        }
        if (binding.reviewId === undefined) {
          throw new Error("Plan Review terminal binding is missing reviewId.");
        }
        return compactPlanReview(binding);
      }

      throw new Error("Plan Review binding is stale or does not match the current round and plan.");
    }

    if (operation === "review-status") {
      if (binding === undefined) throw new Error("Plan Review status requires a prepared binding.");
      if (binding.planRef !== input.planRef || binding.round !== input.round) {
        throw new Error("Plan Review status does not match the current round and plan.");
      }
      if (binding.reviewId === undefined) {
        throw new Error("Plan Review status cannot recover without a reviewId.");
      }
      return compactPlanReview(binding);
    }

    if (binding === undefined) throw new Error("Plan Review record requires a prepared binding.");
    if (binding.planRef !== input.planRef || binding.round !== input.round) {
      throw new Error("Plan Review record does not match the current round and plan.");
    }
    if (binding.status !== "pending") {
      throw new Error("Plan Review status transition is invalid from a terminal state.");
    }
    if (controlState.phase !== "plan-review") {
      throw new Error("Plan Review record requires a completed prepare-review operation.");
    }
    assertReference(input.reviewId, "Plan Review reviewId");
    if (binding.reviewId !== undefined && binding.reviewId !== input.reviewId) {
      throw new Error("Plan Review reviewId does not match the current binding.");
    }
    if (input.status === "rejected") {
      if (input.feedbackRef === undefined) {
        throw new Error("Rejected Plan Review requires a feedbackRef.");
      }
      assertReference(input.feedbackRef, "Plan Review feedbackRef");
    } else if (input.feedbackRef !== undefined) {
      throw new Error("feedbackRef is only valid for a rejected Plan Review.");
    }

    const nextBinding = {
      version: 1,
      status: input.status,
      round: input.round,
      planRef: input.planRef,
      reviewId: input.reviewId,
      ...(input.feedbackRef === undefined ? {} : { feedbackRef: input.feedbackRef }),
    };
    const nextState = {
      ...controlState,
      version: controlState.version === undefined ? 1 : controlState.version,
      planReview: nextBinding,
    };
    assertMissionState(nextState, true);
    if (controlState.version === undefined) await state.set("version", 1);
    await state.set("planReview", nextBinding);
    return compactPlanReview(nextBinding);
  }

  const existingState = {};
  for (const key of stateKeys) {
    const value = await state.get(key);
    if (value !== undefined) existingState[key] = value;
  }
  assertMissionState(existingState, false);

  const discoveryRef = existingState.discoveryRef;
  const discoveryMeta = existingState.discoveryMeta;
  if (discoveryRef === undefined) throw new Error("Planning requires discoveryRef from the same Mission.");
  if (discoveryMeta === undefined) throw new Error("Planning requires discoveryMeta from the same Mission.");
  assertReference(discoveryRef, "Planning discoveryRef");
  assertDiscoveryMetadata(discoveryMeta);
  if (discoveryMeta.status !== "ready") throw new Error("Planning requires ready Discovery metadata.");

  const researchMeta = existingState.researchMeta;
  const researchRef = existingState.researchRef;
  if (discoveryMeta.externalResearchRequired) {
    if (researchMeta === undefined) {
      throw new Error(
        "Planning requires completed Research when external research is required.",
      );
    }
    assertResearchMetadata(researchMeta);
    if (researchMeta.status !== "completed") {
      throw new Error(
        "Planning requires completed Research when external research is required.",
      );
    }
    if (researchRef === undefined) {
      throw new Error("Planning requires researchRef when Research is completed.");
    }
    assertReference(researchRef, "Planning researchRef");
  } else {
    if (researchMeta !== undefined || researchRef !== undefined) {
      throw new Error(
        "Planning requires Research state to be absent when external research is not required.",
      );
    }
  }

  if (input.humanInputs !== undefined) assertHumanInputs(input.humanInputs, "Planning humanInputs");
  if (existingState.humanDecisions !== undefined) assertHumanInputs(existingState.humanDecisions);
  const humanDecisions = input.humanInputs ?? existingState.humanDecisions;
  if (discoveryMeta.humanClarificationRequired && (!Array.isArray(humanDecisions) || humanDecisions.length === 0)) {
    throw new Error("Planning requires valid bounded humanDecisions for the required clarification.");
  }

  if (input.round > 1 && input.feedbackRef === undefined) {
    throw new Error("Planning rounds after the first require the previous rejected Plan Review feedbackRef.");
  }
  if (input.feedbackRef !== undefined) {
    assertReference(input.feedbackRef, "Planning feedbackRef");
    const previous = existingState.planReview;
    if (
      input.round <= 1 ||
      previous === undefined ||
      previous.status !== "rejected" ||
      previous.round !== input.round - 1 ||
      previous.planRef !== existingState.planRef ||
      previous.reviewId === undefined ||
      previous.feedbackRef !== input.feedbackRef
    ) {
      throw new Error("Planning feedbackRef must be bound to the previous rejected Plan Review in the same Mission.");
    }
  }
  if (input.round === 1 && existingState.planReview !== undefined) {
    throw new Error("Planning cannot replace an existing Plan Review in the same round.");
  }

  const context = [
    "Create one bounded read-only PlanningDecisionV1 for the requested change.",
    `Planning round: ${input.round}`,
    existingState.requestType === undefined ? "" : `Request type: ${existingState.requestType}`,
    existingState.request === undefined ? "" : `Request:\n${existingState.request}`,
    `Discovery Artifact Reference:\n${discoveryRef}`,
    `Bounded Discovery metadata:\n${JSON.stringify(discoveryMeta)}`,
    researchMeta === undefined ? "External Research: not required. No Research Artifact exists." : `Research Artifact Reference:\n${researchRef}`,
    humanDecisions === undefined ? "" : `Bounded Human decisions:\n${JSON.stringify(humanDecisions)}`,
    input.feedbackRef === undefined ? "" : `Plan feedback Reference:\n${input.feedbackRef}`,
    "Read the referenced Discovery and Research Artifacts when needed; Main has not relayed their bodies.",
    "Define explicit scope, non-goals, acceptance criteria, risks, verification commands, WorkUnits, write scopes, and integration order.",
    "Preserve WorkUnit order exactly as the decision contract requires.",
    "Choose lanes only when WorkUnits are independent; otherwise choose single mode.",
    "Do not guess material product, architecture, policy, or risk decisions.",
    "Do not edit repository files.",
    "Return only a PlanningDecisionV1 object matching the supplied outputSchema.",
  ].filter((line) => line !== "").join("\n\n");

  function requirePlanningResult(result, label) {
    if (!result || result.ok !== true) throw new Error(`${label} failed: ${result?.error ?? result?.output ?? "unknown error"}`);
    if (result.stopped || result.detached || result.interrupted) throw new Error(result.error ?? `${label} did not complete in the foreground.`);
    if (result.structuredOutput === undefined || result.structuredOutput === null) throw new Error(`planning-invalid: ${label} did not return structured output.`);
    if (typeof result.runId !== "string" || !result.runId.trim()) throw new Error(`planning-invalid: ${label} did not return a runId.`);
    assertText(result.runId, MAX_IDENTIFIER_BYTES, `${label} runId`);
  }

  const childParams = {
    agent: "reviewer",
    context: "fresh",
    async: false,
    skill: "pi-planning",
    outputSchema: input.planningDecisionSchema,
    output: input.planningDecisionInputPath,
    outputMode: "file-only",
  };
  const first = await runs.run("planning", { ...childParams, task: context });
  requirePlanningResult(first, "initial Planning reviewer result");
  let result = first;
  let correctionCount = 0;
  let validation = planningValidation(first.structuredOutput);
  if (!validation.schemaValid) {
    throw new Error(`planning-invalid: initial Planning reviewer result failed schema validation:\n${validationText(validation.errors)}`);
  }
  if (validation.errors.length > 0) {
    correctionCount = 1;
    const correctionTask = [
      context,
      "The previous PlanningDecisionV1 matched the JSON schema but failed the resource semantic/byte validation.",
      "Return a corrected PlanningDecisionV1 and fix every validation error below:",
      validationText(validation.errors),
      "When a WorkUnit has no dependency, use dependsOn: [] exactly.",
      "Never put explanatory strings such as none, なし, or N/A in an ID reference field.",
      "ID reference fields may contain only IDs defined in this same PlanningDecisionV1.",
    ].join("\n\n");
    result = await runs.run("planning-correction", {
      ...childParams,
      output: input.correctionDecisionInputPath,
      task: correctionTask,
    });
    requirePlanningResult(result, "automatic Planning correction result");
    validation = planningValidation(result.structuredOutput);
    if (!validation.schemaValid || validation.errors.length > 0) {
      throw new Error(`planning-invalid: semantic/byte validation still failed after one automatic correction:\n${validationText(validation.errors)}`);
    }
  }

  const planningDecision = result.structuredOutput;
  const artifactResult = await runs.host("plan-artifact", {
    kind: "command",
    command: input.planRendererCommand,
    timeoutMs: 120_000,
  });
  if (!artifactResult || artifactResult.ok !== true || artifactResult.state !== "passed") {
    throw new Error(`Plan Artifact generation failed: ${artifactResult?.error ?? "renderer did not complete successfully"}`);
  }
  if (typeof input.planArtifactPath !== "string" || !input.planArtifactPath.trim()) {
    throw new Error("Plan Artifact generation has no resource-owned output path.");
  }
  assertReference(input.planArtifactPath, "Plan Artifact Reference");
  if (typeof artifactResult.stdout !== "string" || !artifactResult.stdout.trim()) {
    throw new Error("Plan Artifact generation produced an empty Artifact.");
  }

  const nextPlanReview =
    input.round > 1
      ? {
          version: 1,
          status: "pending",
          round: input.round,
          planRef: input.planArtifactPath,
        }
      : existingState.planReview;
  const nextState = {
    ...existingState,
    version: existingState.version === undefined ? 1 : existingState.version,
    ...(humanDecisions === undefined ? {} : { humanDecisions }),
    planningDecision,
    planRef: input.planArtifactPath,
    ...(nextPlanReview === undefined ? {} : { planReview: nextPlanReview }),
    phase: input.round > 1 ? "planning" : "plan-review",
  };
  assertMissionState(nextState, true);

  for (const key of ["version", "humanDecisions", "planningDecision", "planRef", "planReview", "phase"]) {
    if (nextState[key] !== undefined && existingState[key] !== nextState[key]) await state.set(key, nextState[key]);
  }

  const compactResult = {
    status: "completed",
    runId: result.runId,
    planRef: input.planArtifactPath,
    planningCorrectionCount: correctionCount,
  };
  assertJson(compactResult, "Planning result", input.planningBounds.resultBytes);
  return compactResult;
}
/* pi-workflow: planning-resource:end */
