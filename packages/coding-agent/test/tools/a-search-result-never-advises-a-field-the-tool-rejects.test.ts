// WHY: a structure search that hit its match limit told the model "narrow path
// or increase limit." The unified search tool accepts `limit` for `type: "files"`
// only, and `rejectCrossTypeFields` throws `Search type "structure" does not
// accept: limit` for the other two, so a model that followed the advice paid a
// call, an error result and a retry to learn the field does not exist. The field
// structure search does accept for a second page is `skip`.
//
// The class this closes: a search result naming a field its own type rejects.
// The suite derives the accepted set per type from `TYPE_FIELDS` at run time and
// the scenario table is keyed by the same record, so a new search type, or a
// field moved between types, turns it red until someone records a decision.
//
// The scan drops rendered content lines (`*12|text`, `12│text`) and hashline
// headers before looking for assignments, because a matched source line may
// contain any bytes at all; every fixture here is written to carry no `name=`
// or `name:` token of its own, so a hit in a scanned line is a notice.
//
// What it does not catch: advice that names a field in prose without an
// assignment ("raise the limit"), a field name a future search type shares with
// another tool, and the notice text of tools other than `search`.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import { type SearchType, searchSchema, TYPE_FIELDS } from "@veyyon/coding-agent/tools/search";
import { removeWithRetries } from "@veyyon/utils";

const SCHEMA_FIELDS = Object.keys(searchSchema.shape);

/** One call per search type that reaches a limit or pagination notice. */
const SCENARIOS: Record<SearchType, { callId: string; args: Record<string, unknown> }> = {
	files: { callId: "advice-files", args: { type: "files", input: "fx-*.txt", limit: 5 } },
	text: { callId: "advice-text", args: { type: "text", input: "needle", path: "." } },
	structure: { callId: "advice-structure", args: { type: "structure", input: "return $X;", path: "many.ts" } },
};

const CONTENT_LINE = /^\s*[*]?\d+\s*[|│:]/;
const HASHLINE_HEADER = /^\[.+#[0-9A-F]{4}\]$/;

function createTestSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

async function withWorkspace<T>(body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-search-advice-"));
	try {
		// 25 files carry the text match so the 20-file window is exceeded, and the
		// same 25 exceed a files limit of 5.
		for (let index = 0; index < 25; index++) {
			await fs.writeFile(path.join(dir, `fx-${index}.txt`), "alpha needle omega\n");
		}
		// 60 return statements exceed the native match limit of 50.
		const functions = Array.from(
			{ length: 60 },
			(_unused, index) => `export function alpha${index}(one: string): string {\n\treturn one;\n}\n`,
		);
		await fs.writeFile(path.join(dir, "many.ts"), functions.join("\n"));
		return await body(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

async function searchText(cwd: string, scenario: { callId: string; args: Record<string, unknown> }): Promise<string> {
	const tools = await createTools(createTestSession(cwd));
	const tool = tools.find(entry => entry.name === "search");
	if (!tool) throw new Error("search tool missing");
	const result = await tool.execute(scenario.callId, scenario.args);
	return result.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

/** Field names the text assigns a value to, outside rendered content lines. */
function assignedFields(text: string): string[] {
	const scanned = text
		.split("\n")
		.filter(line => !CONTENT_LINE.test(line) && !HASHLINE_HEADER.test(line))
		.join("\n");
	return SCHEMA_FIELDS.filter(field => new RegExp(`\\b${field}\\s*[=:]`).test(scanned));
}

describe("a search result never advises a field the tool rejects", () => {
	it("covers every search type the tool declares", () => {
		const declared = Object.keys(TYPE_FIELDS).sort();
		expect(Object.keys(SCENARIOS).sort()).toEqual(declared);
		const declaredOptions: string[] = [...searchSchema.shape.type.options];
		expect(declaredOptions.sort()).toEqual(declared);
	});

	it("names only accepted fields in every type's limit notice", async () => {
		await withWorkspace(async dir => {
			for (const [type, scenario] of Object.entries(SCENARIOS) as Array<
				[SearchType, (typeof SCENARIOS)[SearchType]]
			>) {
				const text = await searchText(dir, scenario);
				const assigned = assignedFields(text);
				// Green-by-luck guard: a scenario that stopped reaching its notice
				// would otherwise pass with nothing to check.
				expect(assigned.length).toBeGreaterThan(0);
				for (const field of assigned) {
					expect(TYPE_FIELDS[type].has(field as keyof typeof searchSchema.shape)).toBe(true);
				}
			}
		});
	});

	it("pages a capped structure search with skip and never with limit", async () => {
		await withWorkspace(async dir => {
			const text = await searchText(dir, SCENARIOS.structure);
			expect(text).toContain("Match limit reached: 60 found, 50 returned.");
			expect(text).toContain("Use skip=50 for the next page");
			expect(text).not.toMatch(/\blimit\s*[=:]/);
		});
	});

	it("pages a capped text search with skip and never with limit", async () => {
		await withWorkspace(async dir => {
			const text = await searchText(dir, SCENARIOS.text);
			expect(text).toContain("Use skip=20 for the next page");
			expect(text).not.toMatch(/\blimit\s*[=:]/);
		});
	});

	it("offers a raised limit for the one type that accepts it", async () => {
		await withWorkspace(async dir => {
			const text = await searchText(dir, SCENARIOS.files);
			expect(text).toMatch(/Use limit=\d+ for more/);
			expect(TYPE_FIELDS.files.has("limit")).toBe(true);
		});
	});

	it("states the per-file cap on a single-file text search", async () => {
		// `skip` pages files, so nothing pages past this cap. Left unsaid the
		// capped count reads as the file's total.
		await withWorkspace(async dir => {
			const wide = Array.from({ length: 4000 }, (_unused, index) => `needle row ${index}`);
			await fs.writeFile(path.join(dir, "wide.txt"), `${wide.join("\n")}\n`);
			const text = await searchText(dir, {
				callId: "advice-text-wide",
				args: { type: "text", input: "needle", path: "wide.txt" },
			});
			expect(text).toContain("Showing the first 200 matches in this file; more matched.");
			expect(text).not.toMatch(/\blimit\s*[=:]/);
		});
	});

	it("states the per-file cap on a multi-file text search", async () => {
		await withWorkspace(async dir => {
			const wide = Array.from({ length: 100 }, (_unused, index) => `needle row ${index}`);
			for (const name of ["wide-a.md", "wide-b.md"]) {
				await fs.writeFile(path.join(dir, name), `${wide.join("\n")}\n`);
			}
			const text = await searchText(dir, {
				callId: "advice-text-multi",
				args: { type: "text", input: "needle", path: "*.md" },
			});
			expect(text).toContain("matches; each file's count is a floor.");
		});
	});

	it("states that the search stopped at its internal ceiling", async () => {
		// Files past the ceiling were never opened, so a caller reading the file
		// count as a total concludes the pattern appears nowhere else.
		await withWorkspace(async dir => {
			const wide = Array.from({ length: 900 }, (_unused, index) => `needle row ${index}`);
			for (const name of ["cap-a.md", "cap-b.md", "cap-c.md"]) {
				await fs.writeFile(path.join(dir, name), `${wide.join("\n")}\n`);
			}
			const text = await searchText(dir, {
				callId: "advice-text-ceiling",
				args: { type: "text", input: "needle", path: "cap-*.md" },
			});
			expect(text).toContain("internal ceiling of 2000 matches");
			expect(text).toContain("the file count is a floor");
		});
	});
});
