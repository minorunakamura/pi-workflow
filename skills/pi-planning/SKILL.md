---
name: pi-planning
description: Read-only planning guidance for turning discovery evidence, external research, and Human decisions into a bounded PlanningDecisionV1.
---

# pi-planning

Use this Skill with a fresh built-in `reviewer` during the Planning Flow.

Return only one machine-readable `PlanningDecisionV1` object matching the
provided schema. Do not edit repository files and do not return a prose-only
plan. Use the supplied discovery/research references as evidence; read the
referenced artifacts when necessary.

When `outputSchema` is provided, do not finish with prose. Always use the
runtime `structured_output` tool to return the final schema-valid result; the
structured result is authoritative even if the preceding reasoning is prose.

The decision must make all of these explicit:

- request summary
- in-scope and out-of-scope work
- acceptance criteria
- constraints and risks
- verification catalog with commands
- implementation mode (`single` or `lanes`)
- WorkUnits in execution/integration order
- each WorkUnit's objective, dependencies, write scope, acceptance criteria,
  and focused verification references
- final verification references
- unresolved Human decisions

Preserve WorkUnit array order. Choose `lanes` only for genuinely independent
WorkUnits; parallel WorkUnits must not depend on one another. Do not infer a
new integration order from a dependency graph. Do not guess material product,
architecture, policy, or risk-acceptance decisions. If a material decision is
unresolved, record it in `unresolvedDecisions`; the Main Session will stop
before Plan Review rather than guessing.

Dependency reference rules are strict:

- A WorkUnit with no dependency must use `dependsOn: []`.
- Never use explanatory strings such as `none`, `なし`, or `N/A` in `dependsOn`
  or any other ID-reference field.
- Every ID-reference field may contain only an ID defined in the same
  `PlanningDecisionV1` (WorkUnit IDs, acceptance-criterion IDs, and
  verification IDs).

Before returning the structured result, check both the schema shape and all
cross-references. A semantic validation error from Main is correction feedback:
fix it in the Planning reviewer result, not in prose. The Main Session may ask
for at most one automatic machine-invalid correction for this Planning result;
a Human Plan rejection starts a separate Planning round and does not consume
that correction.

Keep the plan bounded to the request and do not anticipate implementation,
verification, review, or lane behavior that the approved scope does not need.
