import type { AgentExecutionMode } from "../contracts/execution/agent-execution.js";

export const AGENT_IDS = [
  "scout",
  "researcher",
  "planner",
  "oracle",
  "worker",
  "verifier",
  "reviewer",
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const CORE_SKILL_IDS = [
  "how",
  "why",
  "blast-radius",
  "architect",
  "tdd",
  "interrogate",
  "figure-it-out",
  "show-me-your-work",
  "reflect",
] as const;
export type CoreSkillId = (typeof CORE_SKILL_IDS)[number];

export type AgentAuthority = "D0" | "D1" | "recommendation-only";

export type AgentRequirements = Readonly<{
  must: readonly string[];
  mustNot: readonly string[];
  may: readonly string[];
}>;

export type AgentDefinition = Readonly<{
  id: AgentId;
  version: string;
  role: string;
  mode: AgentExecutionMode;
  maximumNormalAuthority: AgentAuthority;
  authorityScope?: string;
  primarySkills?: readonly CoreSkillId[];
  skillAllowlist: readonly CoreSkillId[];
  requirements: AgentRequirements;
}>;

export const SKILL_ALLOWLISTS = {
  scout: ["how", "why", "blast-radius", "interrogate", "figure-it-out", "reflect"],
  researcher: ["interrogate", "figure-it-out", "reflect"],
  planner: ["architect", "tdd", "interrogate", "figure-it-out", "reflect"],
  oracle: ["architect", "interrogate", "figure-it-out", "reflect"],
  worker: ["tdd", "figure-it-out", "show-me-your-work", "reflect"],
  verifier: ["figure-it-out", "show-me-your-work", "reflect"],
  reviewer: ["blast-radius", "interrogate", "show-me-your-work", "reflect"],
} as const satisfies Readonly<Record<AgentId, readonly CoreSkillId[]>>;

export const AGENT_DEFINITIONS = [
  {
    id: "scout",
    version: "1.0.0",
    role: "read-only repository understanding and factual evidence collection",
    mode: "read-only",
    maximumNormalAuthority: "D0",
    primarySkills: ["how", "why", "blast-radius"],
    skillAllowlist: SKILL_ALLOWLISTS.scout,
    requirements: {
      must: [
        "Distinguish facts/evidence from inference and assumptions.",
        "Identify unresolved questions and evidence gaps.",
        "Surface an Uncertainty candidate only when it is material to the current Requirement/Run: a different answer could change correctness, requested behavior, scope, architecture/design authority, verification, security/safety, concrete compatibility, completion eligibility, or required authority.",
        "Treat a required current-Requirement behavior or verification check unavailable to this Execution as material and surface it for later authorized evidence.",
      ],
      mustNot: [
        "Produce the final implementation design, final Plan, or source change.",
        "Mutate repository source.",
        "Create an Uncertainty merely because information is absent, a convention/caller/CI/external contract was not found, or a hypothetical external risk cannot be ruled out.",
        "Turn a D0 local choice or D1 Plan-bounded choice into a blocking Uncertainty when it remains within current authority and does not materially change the current Requirement.",
      ],
      may: [],
    },
  },
  {
    id: "researcher",
    version: "1.0.0",
    role: "acquire external or missing knowledge with source/evidence traceability",
    mode: "read-only",
    maximumNormalAuthority: "D0",
    skillAllowlist: SKILL_ALLOWLISTS.researcher,
    requirements: {
      must: [
        "Provide source/evidence references for externally derived claims.",
        "Separate external evidence from local repository facts.",
      ],
      mustNot: ["Mutate repository source.", "Resolve D2/D3 decisions."],
      may: [],
    },
  },
  {
    id: "planner",
    version: "1.0.0",
    role: "convert current Requirement/evidence/Decisions into an executable and verifiable Plan",
    mode: "read-only",
    maximumNormalAuthority: "D1",
    skillAllowlist: SKILL_ALLOWLISTS.planner,
    requirements: {
      must: [
        "Define Plan Units, verification checks, Write Scope, affected areas, dependencies, and Acceptance Criterion coverage.",
        "Escalate D2/D3 decisions rather than hiding them in the Plan.",
        "For Bug Playbook, plan against established root-cause evidence.",
      ],
      mustNot: ["Mutate repository source."],
      may: [],
    },
  },
  {
    id: "oracle",
    version: "1.0.0",
    role: "decision support for high uncertainty, high impact, competing options, or conflicting evidence",
    mode: "read-only",
    maximumNormalAuthority: "recommendation-only",
    authorityScope: "D2/D3 remain external authority",
    skillAllowlist: SKILL_ALLOWLISTS.oracle,
    requirements: {
      must: ["Present options, trade-offs, risks, and recommendation."],
      mustNot: ["Claim final authority for D2 or D3.", "Mutate repository source."],
      may: [],
    },
  },
  {
    id: "worker",
    version: "1.0.0",
    role: "apply approved implementation work",
    mode: "write",
    maximumNormalAuthority: "D1",
    authorityScope: "within approved Plan/Write Scope",
    skillAllowlist: SKILL_ALLOWLISTS.worker,
    requirements: {
      must: [
        "Operate only within approved Write Scope.",
        "Preserve pre-existing repository changes.",
        "Report Plan deviations and relevant implementation checks.",
      ],
      mustNot: [
        "Perform Git write operations such as commit, push, merge, rebase, reset, restore, clean, or branch mutation under normal Phase 1 policy.",
        "Make material off-plan D2/D3 choices autonomously.",
        "Treat Worker checks as Formal Verification.",
      ],
      may: ["Run implementation-level checks while working."],
    },
  },
  {
    id: "verifier",
    version: "1.0.0",
    role: "formal verification of current implementation and evidence capture",
    mode: "verify-only",
    maximumNormalAuthority: "D0",
    skillAllowlist: SKILL_ALLOWLISTS.verifier,
    requirements: {
      must: [
        "Execute/observe Verification Checks and record evidence/results; use read-only repository inspection Tools for inspection/manual checks.",
        "Distinguish passed, failed, skipped, and unavailable checks.",
      ],
      mustNot: [
        "Modify source to make checks pass.",
        "Create Findings; that is Reviewer responsibility.",
      ],
      may: [],
    },
  },
  {
    id: "reviewer",
    version: "1.0.0",
    role: "independent evaluation of implementation/evidence or investigation synthesis",
    mode: "read-only",
    maximumNormalAuthority: "D0",
    skillAllowlist: SKILL_ALLOWLISTS.reviewer,
    requirements: {
      must: [
        "Evaluate actual current repository state and relevant evidence independently.",
        "Return evidence-backed Finding candidates/rechecks.",
      ],
      mustNot: [
        "Modify source.",
        "Directly choose final Finding disposition without Orchestrator/domain normalization.",
        "Use figure-it-out in the Phase 1 allowlist; review should surface uncertainty rather than silently solve around it.",
      ],
      may: [],
    },
  },
] as const satisfies readonly AgentDefinition[];
