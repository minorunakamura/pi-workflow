import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeSearch } from "pi-ketch/search";
import type { SearchResponse } from "pi-ketch/search";
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

function normalizeBackend(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("[validation] backend must be a string");
  }
  const backend = value.trim();
  if (!backend) throw new Error("[validation] backend must not be blank");
  if (backend.includes(",")) {
    throw new Error("[validation] backend must name one provider");
  }
  if (!(RESEARCH_SEARCH_BACKENDS as readonly string[]).includes(backend)) {
    throw new Error(
      `[validation] backend must be one of: ${RESEARCH_SEARCH_BACKENDS.join(", ")}`,
    );
  }
  return backend;
}

export function createResearchSearchTool(pi: Pick<ExtensionAPI, "exec">) {
  return defineTool<typeof ResearchSearchInputSchema, SearchResponse>({
    name: "pi_workflow_ketch_search",
    label: "Pi Workflow Ketch Search",
    description:
      "Search the live web with one configured or selected Ketch backend.",
    promptSnippet: "Search the live web with a single Ketch backend",
    parameters: ResearchSearchInputSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const backend = normalizeBackend(params.backend);
      const response = await executeSearch(
        pi,
        {
          query: params.query,
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
    },
  });
}

export default function researcherTools(
  pi: Pick<ExtensionAPI, "registerTool" | "exec">,
): void {
  pi.registerTool(createResearchSearchTool(pi));
}
