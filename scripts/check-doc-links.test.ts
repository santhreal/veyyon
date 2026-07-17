import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkDocLinks, collectAnchors, extractLinks, slugify } from "./check-doc-links";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-links-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function write(rel: string, content: string): void {
	const abs = path.join(root, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
}

describe("slugify", () => {
	it("matches GitHub heading slugs", () => {
		expect(slugify("The Goal")).toBe("the-goal");
		expect(slugify("Config & state (defaults)")).toBe("config--state-defaults");
		expect(slugify("`vey` alias")).toBe("vey-alias");
	});
});

describe("collectAnchors", () => {
	it("collects heading slugs, dedupes repeats, and reads custom ids", () => {
		const anchors = collectAnchors('# Setup\n\n## Setup\n\n## Real {#custom-id}\n\n<a id="html-anchor"></a>\n');
		expect(anchors.has("setup")).toBe(true);
		expect(anchors.has("setup-1")).toBe(true);
		expect(anchors.has("custom-id")).toBe(true);
		expect(anchors.has("html-anchor")).toBe(true);
	});

	it("ignores headings inside fenced code blocks", () => {
		expect(collectAnchors("```\n# not a heading\n```\n# Real\n").has("not-a-heading")).toBe(false);
	});

	it("keeps inline-code text in heading slugs like GitHub does", () => {
		expect(
			collectAnchors("## Environment variables and `.env` files\n").has("environment-variables-and-env-files"),
		).toBe(true);
	});
});

describe("extractLinks", () => {
	it("finds inline links, images, and reference definitions with line numbers", () => {
		const links = extractLinks("intro\n[a](./x.md) and ![img](img.png)\n\n[ref]: other.md\n");
		expect(links).toEqual([
			{ target: "./x.md", line: 2 },
			{ target: "img.png", line: 2 },
			{ target: "other.md", line: 4 },
		]);
	});

	it("skips links inside code fences and inline code", () => {
		expect(extractLinks("```\n[a](dead.md)\n```\nuse `[b](also-dead.md)` inline\n")).toEqual([]);
	});
});

describe("checkDocLinks", () => {
	write("good/target.md", "# Target Heading\ncontent\n");
	write(
		"good/index.md",
		"[ok](./target.md)\n[ok-anchor](./target.md#target-heading)\n[self](#local)\n\n## Local\n{}\n".replace("{}", ""),
	);
	write("bad/dead-file.md", "[gone](./missing.md)\n");
	write("bad/dead-anchor.md", "[gone](../good/target.md#no-such-heading)\n");
	write("ext/external.md", "[site](https://example.com/x) [mail](mailto:a@b.c) [abs](/install.html)\n");
	write("mdbook/src/a.md", "# A\n[to b](b.html)\n");
	write("mdbook/src/b.md", "# B\n");

	it("passes valid file links, anchors, and same-file anchors", () => {
		const result = checkDocLinks(root, ["good/index.md"]);
		expect(result.dead).toEqual([]);
		expect(result.linksChecked).toBe(3);
	});

	it("fails a link to a missing file with file and line", () => {
		const result = checkDocLinks(root, ["bad/dead-file.md"]);
		expect(result.dead).toEqual([
			{ file: "bad/dead-file.md", line: 1, target: "./missing.md", reason: "file not found" },
		]);
	});

	it("fails a link to a missing anchor in an existing file", () => {
		const result = checkDocLinks(root, ["bad/dead-anchor.md"]);
		expect(result.dead.length).toBe(1);
		expect(result.dead[0].reason).toContain("#no-such-heading");
		expect(result.dead[0].reason).toContain("good/target.md");
	});

	it("skips external schemes and counts site-absolute targets without failing", () => {
		const result = checkDocLinks(root, ["ext/external.md"]);
		expect(result.dead).toEqual([]);
		expect(result.skippedExternal).toBe(2);
		expect(result.skippedAbsolute).toEqual(["ext/external.md:1 -> /install.html"]);
	});

	it("treats links that escape the repo root as github-web-relative skips, not failures", () => {
		write("webrel.md", "[discussions](../../discussions)\n");
		const result = checkDocLinks(root, ["webrel.md"]);
		expect(result.dead).toEqual([]);
		expect(result.skippedAbsolute).toEqual(["webrel.md:1 -> ../../discussions (escapes repo; github-web-relative)"]);
	});

	it("accepts mdBook .html links whose .md source exists", () => {
		const result = checkDocLinks(root, ["mdbook/src/a.md"]);
		expect(result.dead).toEqual([]);
		expect(result.linksChecked).toBe(1);
	});
});
