import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { SearchTool } from "@veyyon/coding-agent/tools/search";
import { removeWithRetries } from "@veyyon/utils";

/**
 * The unified search facade must route every public discriminator through the
 * production engine while rejecting fields owned by another mode. This suite
 * does not cover each engine's pattern dialect; their engine suites own that.
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
});
