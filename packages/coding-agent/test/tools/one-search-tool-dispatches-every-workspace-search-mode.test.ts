import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import {
	SearchTool,
	type SearchToolDetails,
	type SearchToolInput,
	type SearchType,
	searchSchema,
} from "@veyyon/coding-agent/tools/search/search";
import { removeWithRetries } from "@veyyon/utils";

/** One value per field `searchSchema` declares beyond `type` and `input`. */
const FIELD_SAMPLES: Record<string, string | number | boolean> = {
	path: "sample.ts",
	case: true,
	hidden: true,
	gitignore: false,
	limit: 10,
	skip: 0,
	paths: true,
};

/** The fields each mode's engine takes. Pinned by equality against the schema below. */
const ACCEPTED_FIELDS: Record<SearchType, readonly string[]> = {
	files: ["hidden", "gitignore", "limit"],
	text: ["path", "case", "gitignore", "skip", "paths"],
	structure: ["path", "skip"],
};

const MODE_INPUTS: Record<SearchType, string> = {
	files: "**/*.ts",
	text: "needle",
	structure: "console.log($A)",
};

/**
 * The unified search facade must route every public discriminator through the
 * production engine while rejecting fields owned by another mode. This suite
 * does not cover each engine's pattern dialect; their engine suites own that.
 */
describe("one search tool dispatches every workspace search mode", () => {
	let cwd: string;
	let tool: SearchTool;

	beforeAll(async () => {
		const scratchRoot = path.resolve(import.meta.dirname, "../../../../.internal");
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

	it("keeps the historical slash alias scoped to the workspace", async () => {
		const result = await tool.execute("search-files-root-alias", { type: "files", input: "/" });
		const text = result.content.find(block => block.type === "text")?.text ?? "";

		expect(result.details?.type).toBe("files");
		expect(text).toContain("sample.ts");
	});

	/** Files search is the one mode that streams. Its engine emits the bare
	 * `FileSearchDetails`, and the facade has to wrap each event in the same
	 * discriminated shape the final result carries, or the renderer reads a
	 * partial it cannot dispatch on. */
	it("wraps every streamed files partial in the discriminated result shape", async () => {
		const partials: Array<AgentToolResult<SearchToolDetails>> = [];
		await tool.execute("search-files-stream", { type: "files", input: "**/*.ts" }, undefined, partial => {
			partials.push(partial);
		});

		expect(partials.length).toBeGreaterThan(0);
		for (const partial of partials) {
			expect(partial.details?.type).toBe("files");
			expect(partial.details).not.toHaveProperty("files");
		}
		const streamed = partials.flatMap(partial =>
			partial.details?.type === "files" ? partial.details.result.files : [],
		);
		expect(streamed).toContain("sample.ts");
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

	// The field table listed nine pairs literally, so a field added to `searchSchema` was
	// checked against one mode and left unchecked against the other two. This sweep reads the
	// field set out of the schema at run time and drives every (mode, field) pair: a new field
	// with no sample value, or a mode that starts accepting one it did not, goes red here.
	it("accepts exactly the fields its mode owns, across every field the schema declares", async () => {
		const declaredFields = Object.keys(searchSchema.shape).filter(name => name !== "type" && name !== "input");
		expect(declaredFields.slice().sort()).toEqual(Object.keys(FIELD_SAMPLES).sort());

		for (const type of searchSchema.shape.type.options) {
			for (const field of declaredFields) {
				const params = { type, input: MODE_INPUTS[type], [field]: FIELD_SAMPLES[field] } as SearchToolInput;
				const call = tool.execute(`search-sweep-${type}-${field}`, params);
				if (ACCEPTED_FIELDS[type].includes(field)) {
					const result = await call;
					expect(result.details?.type).toBe(type);
				} else {
					await expect(call).rejects.toThrow(`Search type "${type}" does not accept: ${field}`);
				}
			}
		}
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
		expect(tool.approval(null)).toBe("read");
	});

	it("fails unsupported structure ssh scope without an exec approval prompt", async () => {
		const params = { type: "structure" as const, input: "console.log($A)", path: "ssh://host/repo/**/*.ts" };
		expect(tool.approval(params)).toBe("read");
		await expect(tool.execute("search-structure-ssh", params)).rejects.toThrow("Cannot search a remote ssh:// path");
	});
});
