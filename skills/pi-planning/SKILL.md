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

Keep the plan bounded to the request and do not anticipate implementation,
verification, review, or lane behavior that the approved scope does not need.
