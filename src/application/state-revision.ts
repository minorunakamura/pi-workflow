import type { WorkflowState } from "../ports/run-reader.js";

export function withNextRevision(current: WorkflowState, candidate: WorkflowState): WorkflowState {
  const previousRevision = current.run.state_revision;
  if (previousRevision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("State revision exhausted");
  }
  const stateRevision = previousRevision + 1;
  const { snapshot } = candidate;

  return {
    ...candidate,
    run: { ...candidate.run, state_revision: stateRevision },
    snapshot: {
      ...snapshot,
      requirement: { ...snapshot.requirement, state_revision: stateRevision },
      steps: { ...snapshot.steps, state_revision: stateRevision },
      uncertainties: { ...snapshot.uncertainties, state_revision: stateRevision },
      decisions: { ...snapshot.decisions, state_revision: stateRevision },
      gates: { ...snapshot.gates, state_revision: stateRevision },
      findings: { ...snapshot.findings, state_revision: stateRevision },
      manifest: {
        ...snapshot.manifest,
        state_revision: stateRevision,
        previous_state_revision: previousRevision,
      },
    },
  };
}
