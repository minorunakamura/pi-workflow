import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("TypeScript and test foundation", () => {
  it("keeps strict type checking and package tooling explicit", () => {
    const packageJson: unknown = JSON.parse(
      readFileSync(resolve(projectRoot, "package.json"), "utf8"),
    );
    const tsconfig: unknown = JSON.parse(
      readFileSync(resolve(projectRoot, "tsconfig.json"), "utf8"),
    );

    expect(tsconfig).toEqual(
      expect.objectContaining({
        compilerOptions: expect.objectContaining({ strict: true }),
      }),
    );
    expect(packageJson).toEqual(
      expect.objectContaining({
        packageManager: "pnpm@11.22.0",
        peerDependencies: expect.objectContaining({
          "@earendil-works/pi-coding-agent": "*",
        }),
        devDependencies: expect.objectContaining({
          "@biomejs/biome": expect.any(String),
          oxlint: expect.any(String),
          typescript: expect.any(String),
          vitest: expect.any(String),
        }),
        scripts: expect.objectContaining({
          typecheck: expect.any(String),
          lint: expect.any(String),
          "format:check": expect.any(String),
          test: expect.any(String),
        }),
      }),
    );
  });
});
