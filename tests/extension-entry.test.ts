import { expect, it } from "vitest";

import extension from "../src/index.ts";

it("exports a Pi Extension entry point", () => {
  expect(extension).toEqual(expect.any(Function));
});
