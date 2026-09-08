---
name: pi-workflow
description: Main-session control-plane policy for pi-workflow phase orchestration, ownership boundaries, and fail-closed decisions.
---

# pi-workflow

Use this Skill from the Main Session as the control-plane policy for pi-workflow.

- Keep orchestration policy in the Main Session; delegate repository work to the native `subagent` tool in later phases.
- Treat native Mission, workflowScript, worktree, acceptance, and recovery features as owned by `pi-subagents`.
- Do not create a custom workflow engine, state store, Agent registry, or fallback runtime.
- Stop when a required capability, Human decision, or verification evidence is unavailable.

Step 1 provides the package contract and resources only. Mission lifecycle, phase execution, Human Gates, and recovery are implemented in later Steps.
