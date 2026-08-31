import type { AgentId } from "../agents/definitions.js";

export const PLAYBOOK_IDS = [
  "feature",
  "bug",
  "hotfix",
  "chore",
  "refactor",
  "investigation",
] as const;
export type PlaybookId = (typeof PLAYBOOK_IDS)[number];

export const GATE_REQUIREMENTS = ["required", "conditional", "not-applicable"] as const;
export type GateRequirement = (typeof GATE_REQUIREMENTS)[number];

export type GatePolicy = Readonly<{
  evidence: GateRequirement;
  verification: GateRequirement;
  review: GateRequirement;
}>;

export type PlaybookStep = Readonly<{
  id: string;
  objective: string;
  agent?: AgentId;
  allowedAgents?: readonly AgentId[];
  dependsOn: readonly string[];
  required: boolean;
}>;

export type PlaybookRequirements = Readonly<{
  must: readonly string[];
  mustNot: readonly string[];
  may: readonly string[];
  should: readonly string[];
}>;

export type PlaybookDefinition = Readonly<{
  id: PlaybookId;
  version: string;
  purpose: string;
  baseGraph: readonly PlaybookStep[];
  gatePolicy: GatePolicy;
  requirements: PlaybookRequirements;
}>;

export const GATE_POLICIES = {
  feature: { evidence: "conditional", verification: "required", review: "required" },
  bug: { evidence: "required", verification: "required", review: "required" },
  hotfix: { evidence: "required", verification: "required", review: "required" },
  chore: { evidence: "conditional", verification: "required", review: "conditional" },
  refactor: { evidence: "required", verification: "required", review: "required" },
  investigation: { evidence: "required", verification: "not-applicable", review: "required" },
} as const satisfies Readonly<Record<PlaybookId, GatePolicy>>;

export const PLAYBOOK_DEFINITIONS = [
  {
    id: "feature",
    version: "1.0.0",
    purpose: "introduce user-visible or system behavior safely",
    baseGraph: [
      { id: "scout", objective: "Scout", agent: "scout", dependsOn: [], required: true },
      {
        id: "planner",
        objective: "Planner",
        agent: "planner",
        dependsOn: ["scout"],
        required: true,
      },
      {
        id: "worker",
        objective: "Worker",
        agent: "worker",
        dependsOn: ["planner"],
        required: true,
      },
      {
        id: "verifier",
        objective: "Verifier",
        agent: "verifier",
        dependsOn: ["worker"],
        required: true,
      },
      {
        id: "reviewer",
        objective: "Reviewer",
        agent: "reviewer",
        dependsOn: ["verifier"],
        required: true,
      },
    ],
    gatePolicy: GATE_POLICIES.feature,
    requirements: {
      must: [
        "Planner, Worker, Verifier, and Reviewer are present in the normal feature mutation flow.",
        "A verification pass on the current implementation is required before final review can satisfy completion.",
      ],
      mustNot: [],
      may: ["Researcher/Oracle may be inserted when evidence or design uncertainty requires them."],
      should: [],
    },
  },
  {
    id: "bug",
    version: "1.0.0",
    purpose: "fix a defect based on established behavior/root cause",
    baseGraph: [
      {
        id: "understand",
        objective: "Scout understand",
        agent: "scout",
        dependsOn: [],
        required: true,
      },
      {
        id: "reproduce",
        objective: "Scout reproduce",
        agent: "scout",
        dependsOn: ["understand"],
        required: true,
      },
      {
        id: "root-cause",
        objective: "Scout root-cause",
        agent: "scout",
        dependsOn: ["reproduce"],
        required: true,
      },
      {
        id: "planner",
        objective: "Planner",
        agent: "planner",
        dependsOn: ["root-cause"],
        required: true,
      },
      {
        id: "worker",
        objective: "Worker",
        agent: "worker",
        dependsOn: ["planner"],
        required: true,
      },
      {
        id: "regression-verification",
        objective: "Verifier regression",
        agent: "verifier",
        dependsOn: ["worker"],
        required: true,
      },
      {
        id: "reviewer",
        objective: "Reviewer",
        agent: "reviewer",
        dependsOn: ["regression-verification"],
        required: true,
      },
    ],
    gatePolicy: GATE_POLICIES.bug,
    requirements: {
      must: [
        "Root-cause or equivalent causal evidence must be established before implementation planning.",
        "Verification includes a regression-oriented check when technically possible.",
      ],
      mustNot: [],
      may: [],
      should: [],
    },
  },
  {
    id: "hotfix",
    version: "1.0.0",
    purpose: "rapidly correct a high-urgency defect using the narrowest safe change",
    baseGraph: [
      {
        id: "rapid-understand-root-cause",
        objective: "Rapid understand/root-cause",
        agent: "scout",
        dependsOn: [],
        required: true,
      },
      {
        id: "minimal-plan",
        objective: "Minimal Plan",
        agent: "planner",
        dependsOn: ["rapid-understand-root-cause"],
        required: true,
      },
      {
        id: "worker",
        objective: "Worker",
        agent: "worker",
        dependsOn: ["minimal-plan"],
        required: true,
      },
      {
        id: "critical-verification",
        objective: "Critical Verification",
        agent: "verifier",
        dependsOn: ["worker"],
        required: true,
      },
      {
        id: "reviewer",
        objective: "Reviewer",
        agent: "reviewer",
        dependsOn: ["critical-verification"],
        required: true,
      },
    ],
    gatePolicy: GATE_POLICIES.hotfix,
    requirements: {
      must: [
        "Root-cause evidence and critical verification are preserved despite reduced breadth.",
      ],
      mustNot: [],
      may: [],
      should: ["Keep Write Scope and Plan narrowly bounded."],
    },
  },
  {
    id: "chore",
    version: "1.0.0",
    purpose: "low-behavioral-risk maintenance/configuration/tooling work",
    baseGraph: [
      { id: "scout", objective: "Scout", agent: "scout", dependsOn: [], required: true },
      {
        id: "planner",
        objective: "Planner",
        agent: "planner",
        dependsOn: ["scout"],
        required: true,
      },
      {
        id: "worker",
        objective: "Worker",
        agent: "worker",
        dependsOn: ["planner"],
        required: true,
      },
      {
        id: "verifier",
        objective: "Verifier",
        agent: "verifier",
        dependsOn: ["worker"],
        required: true,
      },
      {
        id: "reviewer",
        objective: "Reviewer",
        agent: "reviewer",
        dependsOn: ["verifier"],
        required: false,
      },
    ],
    gatePolicy: GATE_POLICIES.chore,
    requirements: {
      must: ["Verifier is mandatory for write chores."],
      mustNot: [],
      may: ["Reviewer is included according to risk/policy."],
      should: [],
    },
  },
  {
    id: "refactor",
    version: "1.0.0",
    purpose: "change internal structure while preserving required observable behavior",
    baseGraph: [
      {
        id: "structure-invariants-blast-radius",
        objective: "Scout structure/invariants/blast-radius",
        agent: "scout",
        dependsOn: [],
        required: true,
      },
      {
        id: "planner",
        objective: "Planner",
        agent: "planner",
        dependsOn: ["structure-invariants-blast-radius"],
        required: true,
      },
      {
        id: "worker",
        objective: "Worker",
        agent: "worker",
        dependsOn: ["planner"],
        required: true,
      },
      {
        id: "behavior-preservation",
        objective: "Verifier behavior preservation",
        agent: "verifier",
        dependsOn: ["worker"],
        required: true,
      },
      {
        id: "reviewer",
        objective: "Reviewer",
        agent: "reviewer",
        dependsOn: ["behavior-preservation"],
        required: true,
      },
    ],
    gatePolicy: GATE_POLICIES.refactor,
    requirements: {
      must: [
        "Relevant invariants and behavior-preservation basis are established before Worker execution.",
        "Final Verification evaluates behavior preservation, not merely build success.",
      ],
      mustNot: [],
      may: [],
      should: [],
    },
  },
  {
    id: "investigation",
    version: "1.0.0",
    purpose: "answer a technical question without normal source mutation",
    baseGraph: [
      {
        id: "define-question",
        objective: "Scout define question",
        agent: "scout",
        dependsOn: [],
        required: true,
      },
      {
        id: "investigate",
        objective: "Investigate",
        allowedAgents: ["researcher", "oracle"],
        dependsOn: ["define-question"],
        required: true,
      },
      {
        id: "synthesize",
        objective: "Synthesize",
        dependsOn: ["investigate"],
        required: true,
      },
      {
        id: "reviewer",
        objective: "Reviewer",
        agent: "reviewer",
        dependsOn: ["synthesize"],
        required: true,
      },
    ],
    gatePolicy: GATE_POLICIES.investigation,
    requirements: {
      must: [
        "Produce a reviewed conclusion and explicit answered, partially-answered, or inconclusive outcome state.",
      ],
      mustNot: [
        "Include a normal Worker Step in the base graph.",
        "Require a normal Verification Run when no source change exists.",
      ],
      may: ["Insert a Researcher or Oracle when investigation needs it."],
      should: [],
    },
  },
] as const satisfies readonly PlaybookDefinition[];
