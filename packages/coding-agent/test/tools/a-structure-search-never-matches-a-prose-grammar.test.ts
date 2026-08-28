// WHY: a structure search reported documentation paragraphs as code matches.
// ast-grep selects a grammar per file extension, and the markdown grammar
// produces an inline node that spans a whole paragraph, so the TypeScript
// pattern `logger.warn($$$ARGS)` matched three paragraphs of this repository's
// CHANGELOG.md averaging 2,000 characters each, none of which contains the
// string `logger.warn`. An unscoped structure search returned 8 of 40 matches
// that way, spending roughly 300 tokens per false match.
//
// The class this closes: a structure pattern matched against a grammar that
// cannot represent code. The suite sweeps every grammar the source declares as
// prose, derives whether ast-grep reaches that extension at run time, and fails
// when a declared grammar has no fixture extension, so a new entry cannot be
// added without being exercised.
//
// What it does not catch: a grammar that is structured yet still yields
// meaningless matches for a code pattern (yaml, html, shell are searched and
// kept), and a prose grammar ast-grep gains under an extension this suite does
// not map.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import { PROSE_GRAMMARS } from "@veyyon/coding-agent/tools/structure-search";
import { getLanguageFromPath } from "@veyyon/coding-agent/utils/lang-from-path";
import { astGrep } from "@veyyon/natives";
import { removeWithRetries } from "@veyyon/utils";

const PATTERN = "logger.warn($$$ARGS)";

// A paragraph of prose the markdown grammar matches against PATTERN even though
// it contains no call at all. Shape reproduced from the changelog entry that
// exposed the defect: several inline-code spans and an unterminated one.
const PROSE_PARAGRAPH =
	"A misuse of the queue API inside a worker cell names the API instead of " +
	'failing as a `TypeError` several frames deep. `queue.$$(".row")` answered ' +
	'`queue.$$ is not a function` and `queue.drain(".btn")` answered ' +
	"`queue.drain is not a function`, neither of which says what the facade does " +
	"have; a call that omitted its argument reached the implementation and " +
	"crashed on `selector.trim()` of `undefined`, which names a property of the " +
	"argument rather than the argument. The facade is now wrapped at both call " +
	"sites so an unknown member reports the members that exist, with the closest " +
	"known replacement spelled out for the two that were reached for by name " +
	"(`$$` → `queue.observe()";

const CODE_FILE = "handler.ts";
const CODE_BODY = "export function run(reason: string) {\n\tlogger.warn(reason);\n}\n";

/** Fixture extension per declared prose grammar. A new grammar needs a row. */
const FIXTURE_EXTENSION: Record<string, string> = {
	asciidoc: "adoc",
	csv: "csv",
	latex: "tex",
	log: "log",
	markdown: "md",
	restructuredtext: "rst",
	text: "txt",
	tsv: "tsv",
};

function createTestSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

async function runStructureSearch(
	cwd: string,
	input: string,
	searchPath: string,
): Promise<{ text: string; matchCount: number | undefined }> {
	const tools = await createTools(createTestSession(cwd));
	const tool = tools.find(entry => entry.name === "search");
	expect(tool).toBeDefined();
	const result = await tool!.execute("prose-grammar", { type: "structure", input, path: searchPath });
	const text = result.content.find(content => content.type === "text")?.text ?? "";
	const details = result.details;
	const structureResult = details && typeof details === "object" && "result" in details ? details.result : undefined;
	return { text, matchCount: structureResult?.matchCount };
}

async function withWorkspace<T>(prefix: string, body: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	try {
		return await body(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

describe("a structure search never matches a prose grammar", () => {
	it("declares a fixture extension for every prose grammar it excludes", () => {
		const declared = Object.keys(PROSE_GRAMMARS).sort();
		expect(declared.length).toBeGreaterThan(0);
		const unmapped = declared.filter(grammar => FIXTURE_EXTENSION[grammar] === undefined);
		expect(unmapped).toEqual([]);
		for (const grammar of declared) {
			expect(getLanguageFromPath(`note.${FIXTURE_EXTENSION[grammar]}`)).toBe(grammar);
		}
	});

	it("keeps the code match and drops every prose match the engine produces", async () => {
		const exercised: string[] = [];
		for (const grammar of Object.keys(PROSE_GRAMMARS).sort()) {
			const extension = FIXTURE_EXTENSION[grammar]!;
			await withWorkspace(`prose-${grammar}-`, async dir => {
				const proseFile = `note.${extension}`;
				await fs.writeFile(path.join(dir, proseFile), `${PROSE_PARAGRAPH}\n`);
				await fs.writeFile(path.join(dir, CODE_FILE), CODE_BODY);

				// Reachability is derived, not assumed: ast-grep skips an
				// extension it has no grammar for, and such a grammar cannot be
				// exercised until the engine gains it.
				const raw = await astGrep({ patterns: [PATTERN], path: path.join(dir, proseFile) });
				const { text } = await runStructureSearch(dir, PATTERN, dir);
				const [body = "", note = ""] = text.split("\n\nExcluded ");

				expect(body).toContain(CODE_FILE);
				expect(body).toContain("logger.warn(reason)");
				// The prose file is named only by the exclusion note, never as a
				// result group, and none of its text reaches the caller.
				expect(body).not.toContain(proseFile);
				expect(text).not.toContain("queue.drain is not a function");
				if (raw.totalMatches > 0) {
					exercised.push(grammar);
					expect(note).toStartWith(`${raw.totalMatches} match`);
					expect(note).toContain(proseFile);
					expect(note).toContain("a code pattern cannot match a prose grammar");
				} else {
					expect(note).toBe("");
				}
			});
		}
		// At least one declared grammar must be reachable, or the sweep proves
		// nothing about the filter.
		expect(exercised).toContain("markdown");
	});

	it("reports absence as an exclusion when every match fell in prose", async () => {
		await withWorkspace("prose-only-", async dir => {
			await fs.writeFile(path.join(dir, "note.md"), `${PROSE_PARAGRAPH}\n`);
			const { text, matchCount } = await runStructureSearch(dir, PATTERN, dir);

			expect(text).toContain("No code matches");
			expect(text).toContain("Excluded 1 match in 1 documentation file");
			expect(text).toContain("Scope `path` to the language the pattern is written for");
			expect(text).not.toContain("queue.drain is not a function");
			// The engine still counted the prose match, so the reported total is
			// the engine's; the message states what was withheld.
			expect(matchCount).toBe(1);
		});
	});

	it("leaves a code-grammar result untouched", async () => {
		await withWorkspace("prose-control-", async dir => {
			await fs.writeFile(path.join(dir, CODE_FILE), CODE_BODY);
			const { text, matchCount } = await runStructureSearch(dir, PATTERN, dir);

			expect(text).toContain("logger.warn(reason)");
			expect(text).not.toContain("Excluded");
			expect(matchCount).toBe(1);
		});
	});

	it("still reports genuine absence as absence", async () => {
		await withWorkspace("prose-absent-", async dir => {
			await fs.writeFile(path.join(dir, CODE_FILE), CODE_BODY);
			const { text } = await runStructureSearch(dir, "logger.trace($$$ARGS)", dir);

			expect(text).toContain("No matches found (searched");
			expect(text).not.toContain("Excluded");
			expect(text).not.toContain("No code matches");
		});
	});
});
