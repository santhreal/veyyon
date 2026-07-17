// The rendered handbook (docs/handbook/book) is committed, and the docs.yml
// book-staleness gate rebuilds it with a pinned mdbook version. That version
// is also what deployment.md tells contributors to install — if the two
// drift, a contributor following the docs produces a book the gate rejects
// (mdbook output differs across versions). Lock the pin to one value named
// consistently everywhere it appears.

import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "docs.yml");
const DEPLOYMENT_DOC = path.join(ROOT, "docs", "internal", "deployment.md");

describe("handbook mdbook version pin", () => {
	it("docs.yml pins exactly one mdbook version, and its error message names it", async () => {
		const workflow = await Bun.file(WORKFLOW).text();
		const versions = [...workflow.matchAll(/mdbook[- ]v(\d+\.\d+\.\d+)/g)].map(m => m[1]);
		expect(versions.length).toBeGreaterThanOrEqual(2); // download URL + operator-facing error
		expect(new Set(versions).size).toBe(1);
	});

	it("deployment.md tells contributors to use the same version the gate enforces", async () => {
		const workflow = await Bun.file(WORKFLOW).text();
		const pinned = workflow.match(/mdbook[- ]v(\d+\.\d+\.\d+)/)?.[1];
		expect(pinned).toBeDefined();
		const deployment = await Bun.file(DEPLOYMENT_DOC).text();
		expect(deployment).toContain(`mdbook **v${pinned}**`);
	});
});
