// WHY: a text search printed cap notices that its own output contradicted. Over
// `packages/coding-agent/src/tools` for `export function` it claimed "at least one
// file had more than 20 matches" beside a window whose largest count was 12, claimed
// "stopped at its internal ceiling of 2000 matches" for a result of 63, and labelled
// the file total "84+" after enumerating all 84 matching files. Two causes: the
// per-file flag was computed over every matching file while the notice prints beside
// the 20-file page, and one `limitReached` flag means both "the 2000-match fetch
// ceiling was hit" (which leaves files unopened) and "one file's match list was
// clipped" (which does not).
//
// The class this closes: a cap notice whose condition is broader than the claim it
// makes. Each case below builds a corpus with exact known counts and asserts both
// directions, so a notice that fires early and a notice that stops firing are each
// red. The negative controls are the point: asserting only that a notice appears
// leaves a permanently-on notice green.
//
// What it does not catch: the wording of a notice once its condition is right, the
// structure and files search notices (their own suites own those), and a native grep
// that miscounts matches, since every count here comes from that same layer.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools } from "@veyyon/coding-agent/tools";
import {
	DEFAULT_FILE_LIMIT,
	MULTI_FILE_PER_FILE_MATCHES,
	SINGLE_FILE_MATCHES,
} from "@veyyon/coding-agent/tools/search/text-search";
import { removeWithRetries } from "@veyyon/utils";
import { makeToolSession } from "../helpers/tool-session";

const NEEDLE = "findMe";
const CEILING_CLAIM = "internal ceiling";
const PER_FILE_CLAIM = `more than ${MULTI_FILE_PER_FILE_MATCHES} matches`;
const SINGLE_FILE_CLAIM = `Showing the first ${SINGLE_FILE_MATCHES} matches in this file`;

/** One line per match so a file's match count equals the line count. */
function fileWith(matches: number): string {
	return `${Array.from({ length: matches }, (_, index) => `const ${NEEDLE}${index} = ${index};`).join("\n")}\n`;
}

interface Corpus {
	dir: string;
	search: (args: Record<string, unknown>) => Promise<string>;
}

async function corpusOf(files: Record<string, string>): Promise<Corpus> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "search-cap-notice-"));
	for (const [name, content] of Object.entries(files)) {
		const target = path.join(dir, name);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, content, "utf-8");
	}
	let artifacts = 0;
	const session = makeToolSession({
		cwd: dir,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		// Compact broad output needs somewhere to spill; without it the tool falls back to
		// byte truncation and the notices under test render in a different branch.
		allocateOutputArtifact: async (toolType: string) => {
			artifacts++;
			return { id: `${toolType}-${artifacts}`, path: path.join(dir, `.artifact-${artifacts}`) };
		},
	});
	const tools = await createTools(session);
	const tool = tools.find(entry => entry.name === "search");
	if (!tool) throw new Error("search tool missing from the registry");
	return {
		dir,
		search: async (args: Record<string, unknown>) => {
			const result = await tool.execute("cap-notice", args);
			return result.content
				.filter(content => content.type === "text")
				.map(content => content.text)
				.join("\n");
		},
	};
}

describe("a search cap notice is true of the result it prints", () => {
	it("stays silent about a per-file cap no displayed file reached", async () => {
		// More files than the page holds, and one file over the per-file cap placed past
		// that page. The notice sits beside counts that all satisfy the cap, so making it
		// about "any matching file" states something the reader can see is false.
		const files: Record<string, string> = {};
		for (let index = 1; index <= DEFAULT_FILE_LIMIT + 4; index++) {
			files[`f${String(index).padStart(2, "0")}.ts`] = fileWith(3);
		}
		const overCapName = `f${String(DEFAULT_FILE_LIMIT + 4).padStart(2, "0")}.ts`;
		files[overCapName] = fileWith(MULTI_FILE_PER_FILE_MATCHES + 5);
		const corpus = await corpusOf(files);
		try {
			const firstPage = await corpus.search({ type: "text", input: NEEDLE, path: "." });
			expect(firstPage).not.toContain(PER_FILE_CLAIM);
			// Negative control on the other direction: paging to the capped file must say so.
			const lastPage = await corpus.search({ type: "text", input: NEEDLE, path: ".", skip: DEFAULT_FILE_LIMIT });
			expect(lastPage).toContain(PER_FILE_CLAIM);
		} finally {
			await removeWithRetries(corpus.dir);
		}
	});

	it("stays silent about the fetch ceiling far below it, and names the file total exactly", async () => {
		// A clipped per-file list used to set the same flag as an exhausted fetch budget,
		// so a 75-match search reported the 2000-match ceiling and marked its complete
		// file total as a floor.
		const files: Record<string, string> = {};
		for (let index = 1; index <= DEFAULT_FILE_LIMIT + 5; index++) {
			files[`g${String(index).padStart(2, "0")}.ts`] = fileWith(3);
		}
		files["g01.ts"] = fileWith(MULTI_FILE_PER_FILE_MATCHES + 5);
		const totalFiles = Object.keys(files).length;
		const corpus = await corpusOf(files);
		try {
			const output = await corpus.search({ type: "text", input: NEEDLE, path: "." });
			expect(output).not.toContain(CEILING_CLAIM);
			// The page notice carries the total; a clipped file leaves no file unopened.
			expect(output).toContain(`of ${totalFiles}.`);
			expect(output).not.toContain(`of ${totalFiles}+`);
		} finally {
			await removeWithRetries(corpus.dir);
		}
	});

	it("renders no more matches for a file than the per-file notice claims", async () => {
		// The notice tells the reader a file's list was clipped at the cap. If the render
		// then shows more than the cap, the notice describes a limit that was not applied.
		const corpus = await corpusOf({
			"wide.ts": fileWith(MULTI_FILE_PER_FILE_MATCHES + 5),
			"narrow.ts": fileWith(3),
		});
		try {
			const output = await corpus.search({ type: "text", input: NEEDLE, path: "." });
			expect(output).toContain(PER_FILE_CLAIM);
			const matchLines = output.split("\n").filter(line => /^\s*\*?\d+:/.test(line));
			expect(matchLines.length).toBeLessThanOrEqual(MULTI_FILE_PER_FILE_MATCHES + 3);
		} finally {
			await removeWithRetries(corpus.dir);
		}
	});

	it("names the single-file cap only once the file exceeds it", async () => {
		const under = await corpusOf({ "one.ts": fileWith(SINGLE_FILE_MATCHES - 1) });
		try {
			expect(await under.search({ type: "text", input: NEEDLE, path: "one.ts" })).not.toContain(SINGLE_FILE_CLAIM);
		} finally {
			await removeWithRetries(under.dir);
		}
		const over = await corpusOf({ "one.ts": fileWith(SINGLE_FILE_MATCHES + 50) });
		try {
			expect(await over.search({ type: "text", input: NEEDLE, path: "one.ts" })).toContain(SINGLE_FILE_CLAIM);
		} finally {
			await removeWithRetries(over.dir);
		}
	});

	it("reports a per-file count as a floor only when that file was capped", async () => {
		// The `paths` projection prints counts without match lines, so a capped count there
		// is the one a reader takes as the file's total.
		const corpus = await corpusOf({
			"a.ts": fileWith(2),
			"b.ts": fileWith(3),
		});
		try {
			const output = await corpus.search({ type: "text", input: NEEDLE, path: ".", paths: true });
			expect(output).toContain("a.ts: 2");
			expect(output).toContain("b.ts: 3");
			expect(output).not.toContain("floor");
		} finally {
			await removeWithRetries(corpus.dir);
		}
	});
});
