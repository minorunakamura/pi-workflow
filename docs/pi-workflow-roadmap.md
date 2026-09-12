# pi-workflow roadmap

## Current

Planning MVP is complete and supported:

```text
/wf-* → Discovery → optional Research → optional clarification
      → Planning → Plan Review → approved Plan → Mission completed
```

The supported runtime ends after Human approval of the canonical Plan.

## Design under review

Implementation Runtime v1 is **design under review / not implemented**. See the
[Implementation Runtime v1 design](pi-workflow-implementation-runtime-v1-design.md).

The design keeps Planning and Implementation in the same Mission. One
Implementation named resource launches one package-owned worker run, which
processes all WorkUnits in array order in a shared checkout. It does not change
the current supported runtime until implementation and cutover are explicitly
completed.

## Deferred

- parallel implementation lanes, `runs.lanes`, and managed worktrees
- formal Verification and Verification Fix
- automated Review
- Human Code Review
- Web monitoring implementation and operational monitoring
- deployment and release

Each deferred capability requires a new design decision before implementation.
This roadmap records status only; the design document defines the unimplemented
Implementation Runtime v1 proposal.
