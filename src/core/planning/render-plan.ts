import { renderPlan as renderCanonicalPlan } from "./render-plan-runtime.js";
import type { PlanningDecisionV1 } from "./planning-decision";

export const renderPlan: (decision: PlanningDecisionV1) => string =
  renderCanonicalPlan;
