import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool } from "@veyyon/coding-agent/tools/search";
import { removeWithRetries } from "@veyyon/utils";

/**
 * The unified search facade must route every public discriminator through the
 * production engine while rejecting fields owned by another mode. Files-mode
 * tolerates an accidental `path` field but keeps `input` authoritative; this
 * recovers provider calls without making the public contract ambiguous.
 */
describe("one search tool dispatches every workspace search mode", () => {
	let cwd: string;
	let tool: SearchTool;

	beforeAll(async () => {
		const scratchRoot = path.join(process.cwd(), ".internal");
		await fs.mkdir(scratchRoot, { recursive: true });
		cwd = await fs.mkdtemp(path.join(scratchRoot, "search-tool-test-"));
		await fs.writeFile(path.join(cwd, "sample.ts"), 'console.log("needle");\n', "utf8");
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(cwd, "artifacts"),
			settings: Settings.isolated(),
		};
		tool = new SearchTool(session);
	});

	afterAll(async () => {
		await removeWithRetries(cwd);
	});

	it.each([
		["files", { type: "files", input: "**/*.ts" }],
		["text", { type: "text", input: "needle", path: "sample.ts" }],
		["structure", { type: "structure", input: "console.log($A)", path: "sample.ts" }],
	] as const)("routes %s through its production engine", async (type, input) => {
		const result = await tool.execute(`search-${type}`, input);
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(result.details?.type).toBe(type);
		expect(text).toContain("sample.ts");
	});

	it("rejects a field owned by another mode but ignores an absent optional field", async () => {
		await expect(
			tool.execute("search-invalid-field", { type: "text", input: "needle", hidden: true }),
		).rejects.toThrow('Search type "text" does not accept: hidden');

		const result = await tool.execute("search-undefined-field", {
			type: "text",
			input: "needle",
			path: "sample.ts",
			hidden: undefined,
		});
		expect(result.details?.type).toBe("text");
	});

	it("tolerates files path but keeps the required input authoritative", async () => {
		const result = await tool.execute("search-files-extra-path", {
			type: "files",
			input: "**/*.ts",
			path: "missing-scope",
		});
		const text = result.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("sample.ts");
		expect(tool.filesystemTargets({ type: "files", input: "src/**/*.ts", path: "/outside" })).toEqual(["src"]);
	});

	it("rejects empty or whitespace search input", async () => {
		await expect(tool.execute("search-empty", { type: "files", input: "   " })).rejects.toThrow(
			"Search input must not be empty",
		);
	});

	it("rejects invalid search type", async () => {
		await expect(
			tool.execute("search-invalid-type", { type: "invalid" as unknown as "files", input: "foo" }),
		).rejects.toThrow('Invalid search type "invalid"');
	});

	it.each([
		["files", { type: "files" as const, input: "**/*.ts", case: true }, "case"],
		["files", { type: "files" as const, input: "**/*.ts", skip: 0 }, "skip"],
		["text", { type: "text" as const, input: "needle", hidden: true }, "hidden"],
		["text", { type: "text" as const, input: "needle", limit: 10 }, "limit"],
		["structure", { type: "structure" as const, input: "console.log($A)", case: true }, "case"],
		["structure", { type: "structure" as const, input: "console.log($A)", hidden: true }, "hidden"],
		["structure", { type: "structure" as const, input: "console.log($A)", limit: 10 }, "limit"],
		["structure", { type: "structure" as const, input: "console.log($A)", gitignore: false }, "gitignore"],
	])("rejects invalid cross-type field for %s", async (mode, params, invalidField) => {
		await expect(tool.execute(`search-cross-${mode}-${invalidField}`, params)).rejects.toThrow(
			`Search type "${mode}" does not accept: ${invalidField}`,
		);
	});

	it("resolves filesystem targets per search mode", () => {
		expect(tool.filesystemTargets({ type: "files", input: "src/**/*.ts" })).toEqual(["src"]);
		expect(tool.filesystemTargets({ type: "text", input: "needle", path: "src" })).toEqual(["src"]);
		expect(tool.filesystemTargets({ type: "structure", input: "console.log($A)", path: "src/**/*.ts" })).toEqual([
			"src",
		]);
		expect(tool.filesystemTargets({ type: "text", input: "needle" })).toEqual([]);
		expect(tool.filesystemTargets(null)).toEqual([]);
	});

	it("assigns tool tier approval according to target", () => {
		expect(tool.approval({ type: "files", input: "src/**/*.ts" })).toBe("read");
		expect(tool.approval({ type: "text", input: "needle", path: "src" })).toBe("read");
		expect(tool.approval({ type: "text", input: "needle", path: "ssh://host/path" })).toBe("exec");
		expect(tool.approval({ type: "structure", input: "console.log($A)", path: "src/**/*.ts" })).toBe("read");
		expect(tool.approval({ type: "structure", input: "console.log($A)", path: "ssh://host/path" })).toBe("exec");
		expect(tool.approval(null)).toBe("read");
	});
});
