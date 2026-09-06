// The rendered handbook (docs/handbook/book) is a gitignored build output, and
// the docs.yml, site.yml, and ci.yml workflows plus test sandbox guest Dockerfile
// build it with a pinned mdbook version. That version is also what deployment.md
// tells contributors to install — if any drift, a contributor following the docs
// produces a book the gate rejects (mdbook output differs across versions). Lock
// the pin to one value named consistently everywhere it appears.

import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const DOCS_WORKFLOW = path.join(ROOT, ".github", "workflows", "docs.yml");
const SITE_WORKFLOW = path.join(ROOT, ".github", "workflows", "site.yml");
const CI_WORKFLOW = path.join(ROOT, ".github", "workflows", "ci.yml");
const DOCKERFILE = path.join(ROOT, "scripts", "test-sandbox", "guest", "Dockerfile");
const DEPLOYMENT_DOC = path.join(ROOT, "docs", "internal", "deployment.md");
const GITIGNORE = path.join(ROOT, ".gitignore");

describe("handbook mdbook version pin and build contract", () => {
	it("docs.yml pins exactly one mdbook version, and its error message names it", async () => {
		const workflow = await Bun.file(DOCS_WORKFLOW).text();
		const versions = [...workflow.matchAll(/mdbook[- ]v(\d+\.\d+\.\d+)/g)].map(m => m[1]);
		expect(versions.length).toBeGreaterThanOrEqual(2); // download URL + operator-facing error
		expect(new Set(versions).size).toBe(1);
	});

	it("deployment.md tells contributors to use the same version the gate enforces", async () => {
		const workflow = await Bun.file(DOCS_WORKFLOW).text();
		const pinned = workflow.match(/mdbook[- ]v(\d+\.\d+\.\d+)/)?.[1];
		expect(pinned).toBeDefined();
		const deployment = await Bun.file(DEPLOYMENT_DOC).text();
		expect(deployment).toContain(`mdbook **v${pinned}**`);
	});

	it("site.yml and ci.yml pin the same mdbook version as docs.yml", async () => {
		const docsWorkflow = await Bun.file(DOCS_WORKFLOW).text();
		const siteWorkflow = await Bun.file(SITE_WORKFLOW).text();
		const ciWorkflow = await Bun.file(CI_WORKFLOW).text();
		const docsPinned = docsWorkflow.match(/mdbook[- ]v(\d+\.\d+\.\d+)/)?.[1];
		const sitePinned = siteWorkflow.match(/mdbook[- ]v(\d+\.\d+\.\d+)/)?.[1];
		const ciPinned = ciWorkflow.match(/mdbook[- ]v(\d+\.\d+\.\d+)/)?.[1];
		expect(docsPinned).toBeDefined();
		expect(sitePinned).toBe(docsPinned);
		expect(ciPinned).toBe(docsPinned);
	});

	it("test sandbox guest Dockerfile pins the same mdbook version", async () => {
		const docsWorkflow = await Bun.file(DOCS_WORKFLOW).text();
		const dockerfile = await Bun.file(DOCKERFILE).text();
		const docsPinned = docsWorkflow.match(/mdbook[- ]v(\d+\.\d+\.\d+)/)?.[1];
		const dockerPinned = dockerfile.match(/MDBOOK_VERSION=(\d+\.\d+\.\d+)/)?.[1];
		expect(docsPinned).toBeDefined();
		expect(dockerPinned).toBe(docsPinned);
	});

	it(".gitignore ignores docs/handbook/book/", async () => {
		const gitignore = await Bun.file(GITIGNORE).text();
		const lines = gitignore.split("\n").map(l => l.trim());
		expect(lines.some(l => l === "docs/handbook/book/" || l === "/docs/handbook/book/")).toBe(true);
	});

	it("site.yml triggers on handbook source paths and does not track generated book paths", async () => {
		const siteWorkflow = await Bun.file(SITE_WORKFLOW).text();
		expect(siteWorkflow).toContain("docs/handbook/**");
		expect(siteWorkflow).not.toContain("docs/handbook/book/**");
	});
});
