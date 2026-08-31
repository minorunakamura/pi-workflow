import type { AgentExecutionRequestV1 } from "../contracts/execution/agent-execution.js";

/** Agent output crosses a trust boundary and is validated by the Orchestrator. */
export interface AgentRuntime {
  run(request: AgentExecutionRequestV1): Promise<unknown>;
}
