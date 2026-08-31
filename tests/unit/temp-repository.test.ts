import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withTempRepository } from "../fixtures/temp-repository.js";

describe("withTempRepository", () => {
  it("writes nested fixture files and cleans up after the callback", async () => {
    let root = "";

    const result = await withTempRepository(
      {
        "README.md": "fixture",
        "config/workflow.json": '{"enabled":true}',
      },
      async (temporaryRoot) => {
        root = temporaryRoot;
        expect(await readFile(join(temporaryRoot, "README.md"), "utf8")).toBe("fixture");
        expect(await readFile(join(temporaryRoot, "config/workflow.json"), "utf8")).toBe(
          '{"enabled":true}',
        );
        return "completed";
      },
    );

    expect(result).toBe("completed");
    await expect(access(root)).rejects.toThrow();
  });

  it("cleans up when the callback fails", async () => {
    let root = "";

    await expect(
      withTempRepository({}, async (temporaryRoot) => {
        root = temporaryRoot;
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");

    await expect(access(root)).rejects.toThrow();
  });

  it("rejects fixture files outside the temporary repository", async () => {
    await expect(
      withTempRepository({ "../outside.txt": "unsafe" }, async () => undefined),
    ).rejects.toThrow("temporary repository");
  });
});
