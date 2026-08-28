import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	buildDiscoverableToolSearchIndex,
	collectDiscoverableTools,
	type DiscoverableTool,
	type DiscoverableToolSearchIndex,
	searchDiscoverableTools,
} from "@veyyon/coding-agent/tool-discovery/tool-index";
import { createTools } from "@veyyon/coding-agent/tools";

/**
 * WHY. Discovery indexed a tool's `summary` and nothing else. A tool declares a 40-to-60 character
 * blurb, so 96-99% of what each tool said about itself was unsearchable: `launch` scored zero for
 * "tail the output of a server I launched" and `eval` scored zero for "evaluate javascript",
 * because "server", "tail" and "javascript" all sit past the blurb. The tools WITH a curated blurb
 * were indexed on a quarter of the text of the tools without one, so `goal` and `set_cwd`
 * outranked the tool that owned the capability. Under `tools.discoveryMode: "all"` a tool the
 * model cannot retrieve is a tool it does not have, which is why `launch` and `eval` were pinned
 * into the essential set at 3,877 tokens on every request.
 *
 * The class this closes: any indexing change that drops part of a tool's own text out of the
 * retrieval corpus, and any tokenizer change that makes a term in the corpus unreachable by a
 * query spelling the same word. Both arms derive their members from the live tool registry, so a
 * new tool joins the sweep without being named here.
 *
 * What it does not catch: ranking quality between two tools that both match, the score floor that
 * decides activation (`a-discovery-match-activates-on-strength.test.ts` owns that), and any
 * retrieval failure for a word that appears in NO tool description.
 */

interface Corpus {
	tools: DiscoverableTool[];
	index: DiscoverableToolSearchIndex;
}

async function buildCorpus(): Promise<Corpus> {
	const session = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
	const tools = collectDiscoverableTools(await createTools(session as never));
	return { tools, index: buildDiscoverableToolSearchIndex(tools) };
}

/** Rank a query against the WHOLE corpus, so a missing tool is a real miss and not a `limit` cut. */
function rank(corpus: Corpus, query: string): string[] {
	return searchDiscoverableTools(corpus.index, query, corpus.index.documents.length).map(result => result.tool.name);
}

const WORD_RE = /[\p{L}\p{N}]{4,}/gu;
const COMPOUND_RE = /\p{Ll}\p{Lu}/u;

/** Words in `text`, lowercased, 4+ characters so a match carries signal. */
function wordsOf(text: string): Set<string> {
	return new Set(Array.from(text.matchAll(WORD_RE), match => match[0].toLowerCase()));
}

const corpus = await buildCorpus();

describe("a tool is reachable by every word of its description", () => {
	it("indexes the whole registry, and every tool carries its own text", () => {
		expect(corpus.tools.length).toBeGreaterThan(10);
		expect(corpus.index.documents).toHaveLength(corpus.tools.length);
		// A tool whose description never reaches the descriptor drops out of the sweeps below
		// instead of failing them, which is how indexing the blurb alone stayed invisible.
		expect(corpus.tools.filter(tool => !tool.description).map(tool => tool.name)).toEqual([]);
		expect(corpus.tools.filter(tool => tool.summary.length === 0).map(tool => tool.name)).toEqual([]);
	});

	it("reaches each tool by a word its description owns and its summary omits", () => {
		// A term only ONE document holds identifies that document outright, so retrieval either
		// returns it first or cannot see it at all. Derived from the index, never transcribed.
		const unreachable: string[] = [];
		const unconstructable: string[] = [];
		for (const tool of corpus.tools) {
			if (!tool.description) continue; // The case above already failed for this tool.
			const summaryWords = wordsOf(tool.summary);
			const owned = Array.from(wordsOf(tool.description)).filter(
				word => !summaryWords.has(word) && corpus.index.documentFrequencies.get(word) === 1,
			);
			if (owned.length === 0) {
				unconstructable.push(tool.name);
				continue;
			}
			for (const word of owned.slice(0, 12)) {
				const names = rank(corpus, word);
				if (names[0] !== tool.name) unreachable.push(`${tool.name} <- "${word}" got ${names[0] ?? "nothing"}`);
			}
		}
		expect(unreachable).toEqual([]);
		// A tool the sweep cannot exercise is a hole in it, not a pass.
		expect(unconstructable).toEqual([]);
	});

	it("reaches each tool by a word from the last quarter of its description", () => {
		// Truncating the corpus is the defect's whole class, and it survives any single ceiling:
		// a later 2,000-character window would still hide the back half of `edit` and `eval`.
		// Anchoring on the tail closes the class at every N rather than at 200.
		const unreachable: string[] = [];
		const unconstructable: string[] = [];
		for (const tool of corpus.tools) {
			if (!tool.description) continue;
			const tail = tool.description.slice(Math.floor(tool.description.length * 0.75));
			const owned = Array.from(wordsOf(tail)).filter(word => corpus.index.documentFrequencies.get(word) === 1);
			if (owned.length === 0) {
				unconstructable.push(tool.name);
				continue;
			}
			for (const word of owned.slice(0, 6)) {
				const names = rank(corpus, word);
				if (names[0] !== tool.name) unreachable.push(`${tool.name} <- "${word}" got ${names[0] ?? "nothing"}`);
			}
		}
		expect(unreachable).toEqual([]);
		expect(unconstructable).toEqual([]);
	});

	it("reaches each tool by a word its curated summary owns and its description omits", () => {
		// A blurb is not a prefix of the description: `launch` says "supervise", `ast_edit` says
		// "refactoring", `task` says "delegated", and none of those words appear in the body. The
		// blurb has to stay in the corpus beside the description, not be replaced by it.
		const unreachable: string[] = [];
		let covered = 0;
		for (const tool of corpus.tools) {
			if (!tool.description) continue;
			const descriptionWords = wordsOf(tool.description);
			const owned = Array.from(wordsOf(tool.summary)).filter(
				word => !descriptionWords.has(word) && corpus.index.documentFrequencies.get(word) === 1,
			);
			for (const word of owned) {
				covered++;
				const names = rank(corpus, word);
				if (names[0] !== tool.name) unreachable.push(`${tool.name} <- "${word}" got ${names[0] ?? "nothing"}`);
			}
		}
		expect(unreachable).toEqual([]);
		expect(covered).toBeGreaterThan(2);
	});

	it("reaches a compound word from the lowercase spelling of the whole word", () => {
		// "JavaScript" split to "java script" while a query's "javascript" stayed one term, so the
		// two never met. Candidates come from the live descriptions, so a new "SQLite" is covered.
		const candidates = new Map<string, string>();
		for (const tool of corpus.tools) {
			if (!tool.description) continue;
			for (const match of tool.description.matchAll(WORD_RE)) {
				const word = match[0];
				if (!COMPOUND_RE.test(word)) continue;
				const lowered = word.toLowerCase();
				if (corpus.index.documentFrequencies.get(lowered) === 1 && !candidates.has(lowered)) {
					candidates.set(lowered, tool.name);
				}
			}
		}
		expect(candidates.size).toBeGreaterThan(3);
		const missed: string[] = [];
		for (const [lowered, name] of candidates) {
			const names = rank(corpus, lowered);
			if (names[0] !== name) missed.push(`${lowered} -> ${names[0] ?? "nothing"}, expected ${name}`);
		}
		expect(missed).toEqual([]);
	});

	it("still reaches a compound word from its separated parts", () => {
		// The whole-word term is added BESIDE the parts, so the split spelling keeps working.
		const names = rank(corpus, "java script");
		expect(names).toContain("eval");
	});

	it("keeps the model-facing payload on the summary, not the indexed description", () => {
		// The corpus grew; the bytes sent back must not. `search_tool_bm25` reports `tool.summary`.
		for (const tool of corpus.tools) {
			if (!tool.description) continue;
			expect(tool.summary.length).toBeLessThanOrEqual(Math.max(200, tool.description.length));
		}
	});
});
