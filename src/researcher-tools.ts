import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  executeSearch,
  KetchExecutionError,
  type SearchResponse,
} from "pi-ketch/search";
import { Type, type Static } from "typebox";

const ResearchSearchInputSchema = Type.Object(
  {
    query: Type.String({ description: "Search query" }),
    backend: Type.Optional(
      Type.String({ description: "Single Ketch search backend" }),
    ),
  },
  { additionalProperties: false },
);

export type ResearchSearchInput = Static<typeof ResearchSearchInputSchema>;

export type ResearchSearchGuardErrorCode = "duplicate_search" | "failed_search";

export class ResearchSearchGuardError extends Error {
  readonly code: ResearchSearchGuardErrorCode;

  constructor(code: ResearchSearchGuardErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "ResearchSearchGuardError";
    this.code = code;
  }
}

// Derived from the current `ketch search --help` single-backend contract.
// ponytail: closed provider list; update when Ketch adds a supported backend.
export const RESEARCH_SEARCH_BACKENDS = [
  "brave",
  "ddg",
  "searxng",
  "exa",
  "firecrawl",
  "keenable",
] as const;

function validationError(message: string): never {
  throw new KetchExecutionError(`[validation] ${message}`, "validation");
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return validationError("query must not be blank");
  }
  return value.trim();
}

function normalizeBackend(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return validationError("backend must be a string");
  }
  const backend = value.trim();
  if (!backend) return validationError("backend must not be blank");
  if (backend.includes(",")) {
    return validationError("backend must name one provider");
  }
  if (!(RESEARCH_SEARCH_BACKENDS as readonly string[]).includes(backend)) {
    return validationError(
      `backend must be one of: ${RESEARCH_SEARCH_BACKENDS.join(", ")}`,
    );
  }
  return backend;
}

function searchSignature(query: string, backend: string | undefined): string {
  return JSON.stringify({
    query,
    provider:
      backend === undefined ? "configured" : { mode: "single", backend },
  });
}

function isNonRecoverableFailure(error: unknown): boolean {
  return (
    error instanceof KetchExecutionError &&
    (error.code === "validation" ||
      error.code === "precondition" ||
      error.code === "invalid_output")
  );
}

function guardError(
  code: ResearchSearchGuardErrorCode,
): ResearchSearchGuardError {
  return new ResearchSearchGuardError(
    code,
    code === "failed_search"
      ? "This exact search already failed with a non-recoverable result; reuse the existing failure or change the query materially."
      : "This exact search was already executed; reuse the existing evidence or change the query materially.",
  );
}

export function createResearchSearchTool(pi: Pick<ExtensionAPI, "exec">) {
  const executedSearches = new Set<string>();
  const nonRecoverableFailures = new Set<string>();

  return defineTool<typeof ResearchSearchInputSchema, SearchResponse>({
    name: "pi_workflow_ketch_search",
    label: "Pi Workflow Ketch Search",
    description:
      "Search the live web with one configured or selected Ketch backend.",
    promptSnippet: "Search the live web with a single Ketch backend",
    parameters: ResearchSearchInputSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const query = normalizeQuery(params.query);
      const backend = normalizeBackend(params.backend);
      const signature = searchSignature(query, backend);

      if (nonRecoverableFailures.has(signature)) {
        throw guardError("failed_search");
      }
      if (executedSearches.has(signature)) {
        throw guardError("duplicate_search");
      }
      executedSearches.add(signature);

      try {
        const response = await executeSearch(
          pi,
          {
            query,
            provider:
              backend === undefined
                ? { mode: "configured" }
                : { mode: "single", backend },
          },
          { cwd: ctx.cwd, signal },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
          details: response,
        };
      } catch (error) {
        if (isNonRecoverableFailure(error)) {
          nonRecoverableFailures.add(signature);
        }
        throw error;
      }
    },
  });
}

export default function researcherTools(
  pi: Pick<ExtensionAPI, "registerTool" | "exec">,
): void {
  pi.registerTool(createResearchSearchTool(pi));
}
