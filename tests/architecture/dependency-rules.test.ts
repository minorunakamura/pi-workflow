import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = resolve(projectRoot, "src");
const sourceExtensions = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

type ImportReference = {
  from: string;
  specifier: string;
  target: string | undefined;
};

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path));
    } else if (sourceExtensions.includes(extname(entry.name))) {
      files.push(path);
    }
  }

  return files;
}

function sourcePath(file: string): string {
  return relative(sourceRoot, file).split(sep).join("/");
}

function importedSpecifiers(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^;"']*?\sfrom\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : [])),
  );
}

function resolveSourceImport(
  importer: string,
  specifier: string,
  sourceFileSet: ReadonlySet<string>,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const requested = resolve(dirname(importer), specifier);
  const base = requested.replace(/\.[^/.]+$/, "");
  const candidates = [
    requested,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => resolve(requested, `index${extension}`)),
  ];

  return candidates.find((candidate) => sourceFileSet.has(candidate));
}

function collectImports(files: string[]): ImportReference[] {
  const sourceFileSet = new Set(files);

  return files.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return importedSpecifiers(source).map((specifier) => ({
      from: file,
      specifier,
      target: resolveSourceImport(file, specifier, sourceFileSet),
    }));
  });
}

function area(file: string): string {
  return sourcePath(file).split("/")[0] ?? "";
}

function isMonitorForbiddenTarget(file: string): boolean {
  const path = sourcePath(file);
  return (
    /(^|\/)(persistence|write)([./]|$)/.test(path) || /(^|\/)orchestrator(?:[./-]|$)/.test(path)
  );
}

function isPiAdapter(file: string): boolean {
  return /^adapters\/(?:pi(?:[-_/]|$)|.*\/pi(?:[-_/]|$))/i.test(sourcePath(file));
}

function isRepositoryAdapter(file: string): boolean {
  return /^adapters\/(?:repository|git)(?:[-_/.]|$)/i.test(sourcePath(file));
}

function dependencyViolations(imports: ImportReference[]): string[] {
  const violations: string[] = [];
  const add = (reference: ImportReference, reason: string, target = reference.specifier) => {
    violations.push(`${sourcePath(reference.from)} → ${target}: ${reason}`);
  };

  for (const reference of imports) {
    const { from, target } = reference;

    if (reference.specifier === "pi-subagents" || reference.specifier.startsWith("pi-subagents/")) {
      if (!isPiAdapter(from)) {
        add(reference, "pi-subagents is restricted to the Pi adapter area");
      }
    }

    if (
      reference.specifier === "child_process" ||
      reference.specifier.startsWith("node:child_process")
    ) {
      if (!isRepositoryAdapter(from)) {
        add(reference, "Git process invocation is restricted to the repository adapter area");
      }
    }

    if (!target) {
      continue;
    }

    const fromArea = area(from);
    const targetArea = area(target);

    if (fromArea === "domain" && ["application", "adapters"].includes(targetArea)) {
      add(reference, "domain may depend only on domain primitives");
    } else if (fromArea === "application" && targetArea === "adapters") {
      add(reference, "application may not depend on adapters");
    } else if (fromArea === "adapters" && targetArea === "application") {
      add(reference, "adapters may not depend on application");
    } else if (fromArea === "monitor" && isMonitorForbiddenTarget(target)) {
      add(reference, "monitor may not depend on persistence, write, or orchestrator modules");
    } else if (["agents", "playbooks"].includes(fromArea) && targetArea === "adapters") {
      add(reference, "agent and playbook definitions may not depend on adapters");
    }
  }

  return violations;
}

function buildGraph(files: string[], imports: ImportReference[]): Map<string, Set<string>> {
  const graph = new Map(files.map((file) => [file, new Set<string>()]));

  for (const { from, target } of imports) {
    if (target) {
      graph.get(from)?.add(target);
    }
  }

  return graph;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function findCycles(graph: Map<string, Set<string>>): string[] {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const stack: string[] = [];
  const cycles: string[] = [];

  const visit = (file: string): void => {
    if (visiting.has(file)) {
      const cycleStart = stack.indexOf(file);
      if (cycleStart >= 0) {
        cycles.push([...stack.slice(cycleStart), file].map(sourcePath).join(" → "));
      }
      return;
    }
    if (visited.has(file)) {
      return;
    }

    visiting.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) {
      visit(dependency);
    }
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  };

  for (const file of graph.keys()) {
    visit(file);
  }

  return cycles;
}

describe("architecture dependency rules", () => {
  const sourceFiles = collectSourceFiles(sourceRoot);
  const imports = collectImports(sourceFiles);
  const graph = buildGraph(sourceFiles, imports);

  it("rejects forbidden dependency directions and control-plane imports", () => {
    expect(dependencyViolations(imports)).toEqual([]);
  });

  it("rejects circular runtime imports", () => {
    expect(findCycles(graph)).toEqual([]);
  });

  it("resolves package resources without authored .pi implementation dependencies", () => {
    const manifest: unknown = JSON.parse(
      readFileSync(resolve(projectRoot, "package.json"), "utf8"),
    );
    const pi = isRecord(manifest) && isRecord(manifest.pi) ? manifest.pi : undefined;

    if (!pi) {
      throw new Error("package.json must declare a Pi package manifest");
    }

    for (const resources of [pi.extensions, pi.skills]) {
      expect(Array.isArray(resources)).toBe(true);
      if (!Array.isArray(resources)) {
        continue;
      }

      for (const resource of resources) {
        expect(typeof resource).toBe("string");
        if (typeof resource === "string") {
          expect(existsSync(resolve(projectRoot, resource))).toBe(true);
        }
      }
    }

    const forbiddenReferences = sourceFiles.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [".pi/agent/skills", ".pi/workflows"]
        .filter((reference) => source.includes(reference))
        .map((reference) => `${sourcePath(file)} contains ${reference}`);
    });

    expect(forbiddenReferences).toEqual([]);
  });
});
