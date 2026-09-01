import type { DecisionId, RunId } from "../domain/primitives/ids.js";

export const USER_INTERACTION_KINDS = ["approval", "options", "custom"] as const;
export type UserInteractionKind = (typeof USER_INTERACTION_KINDS)[number];

type UserInteractionRequestBase = Readonly<{
  runId: RunId;
  decisionId: DecisionId;
  class: "D3";
  title: string;
  message: string;
}>;

export type UserInteractionRequest =
  | (UserInteractionRequestBase &
      Readonly<{
        kind: "approval";
      }>)
  | (UserInteractionRequestBase &
      Readonly<{
        kind: "options";
        options: readonly string[];
      }>)
  | (UserInteractionRequestBase &
      Readonly<{
        kind: "custom";
        placeholder?: string;
      }>);

export type UserInteractionAnswer = string | boolean;

export type UserInteractionResult =
  | Readonly<{
      kind: "answered";
      answer: UserInteractionAnswer;
    }>
  | Readonly<{
      kind: "cancelled";
    }>;

export interface UserInteraction {
  ask(request: UserInteractionRequest, signal?: AbortSignal): Promise<UserInteractionResult>;
}
