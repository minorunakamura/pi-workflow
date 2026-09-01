import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type {
  UserInteraction,
  UserInteractionRequest,
  UserInteractionResult,
} from "../../ports/user-interaction.js";

type PiUserInterface = Pick<ExtensionUIContext, "select" | "confirm" | "input">;

function cancelled(): UserInteractionResult {
  return { kind: "cancelled" };
}

function dialogOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function assertOptions(options: readonly string[]): void {
  if (options.length === 0 || options.some((option) => option.trim().length === 0)) {
    throw new Error("D3 options interaction requires at least one non-empty option");
  }
}

/** Maps Pi's UI primitives to the UserInteraction Port without changing Workflow State. */
export class PiUserInteractionAdapter implements UserInteraction {
  constructor(private readonly ui: PiUserInterface) {}

  async ask(request: UserInteractionRequest, signal?: AbortSignal): Promise<UserInteractionResult> {
    if (signal?.aborted) return cancelled();

    try {
      switch (request.kind) {
        case "approval": {
          const answer = await this.ui.confirm(
            request.title,
            request.message,
            dialogOptions(signal),
          );
          if (signal?.aborted || answer === undefined) return cancelled();
          if (typeof answer !== "boolean") {
            throw new Error("D3 approval interaction must return a boolean answer");
          }
          return { kind: "answered", answer };
        }
        case "options": {
          assertOptions(request.options);
          const answer = await this.ui.select(
            request.title,
            [...request.options],
            dialogOptions(signal),
          );
          if (signal?.aborted || answer === undefined) return cancelled();
          if (!request.options.includes(answer)) {
            throw new Error("D3 options interaction returned an unavailable option");
          }
          return { kind: "answered", answer };
        }
        case "custom": {
          const answer = await this.ui.input(
            request.title,
            request.placeholder,
            dialogOptions(signal),
          );
          if (signal?.aborted || answer === undefined) return cancelled();
          if (typeof answer !== "string") {
            throw new Error("D3 custom interaction must return a string answer");
          }
          return { kind: "answered", answer };
        }
      }
    } catch (error) {
      if (signal?.aborted) return cancelled();
      throw error;
    }
    throw new Error("Unsupported UserInteraction kind");
  }
}
