// The repo-root CHANGELOG sync shell. Two contracts matter here and are worth a
// dedicated suite: (1) the shell renders through the ONE shared core, so the root
// file can never diverge from the website's changelog logic, and (2) the file
// actually committed at the repo root is in sync with the canonical source — the
// same thing `changelog:root:check` enforces in CI, encoded as a test so a local
// `bun test` catches drift before a push instead of only on the PR.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs module, no types; imported for its exports.
import { renderRootChangelog } from "../website/tools/gen-changelog.mjs";
import { buildRootChangelog, ROOT_PATH, SOURCE_PATH } from "./sync-root-changelog";

describe("buildRootChangelog", () => {
	it("renders through the shared renderRootChangelog core, not a private copy", () => {
		// If the shell ever grew its own rebrand/split logic, this would diverge and
		// the website and repo-root changelogs could drift apart.
		const expected = renderRootChangelog(readFileSync(SOURCE_PATH, "utf8"));
		expect(buildRootChangelog()).toBe(expected);
	});

	it("produces a non-trivial changelog: title, at least one release, and the upstream credit", () => {
		const md = buildRootChangelog();
		expect(md.startsWith("# Changelog\n")).toBe(true);
		expect(md).toMatch(/## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}/); // a real cut release
		expect(md).toContain("## Upstream history");
		expect(md.trimEnd().endsWith("for it.")).toBe(true);
	});

	it("speaks in Veyyon's voice: no leaked upstream omp CLI or scheme tokens", () => {
		const md = buildRootChangelog();
		expect(md).not.toContain("omp://");
		expect(md).not.toMatch(/\bomp /);
	});
});

describe("committed root CHANGELOG.md", () => {
	it("is byte-identical to a fresh render of the source (the CI drift guard, locally)", () => {
		// This is exactly what `bun run changelog:root:check` asserts. Having it as a
		// unit test means editing packages/coding-agent/CHANGELOG.md without running
		// `bun run changelog:root` turns the local suite red, not just CI.
		const onDisk = readFileSync(ROOT_PATH, "utf8");
		expect(onDisk).toBe(buildRootChangelog());
	});
});
