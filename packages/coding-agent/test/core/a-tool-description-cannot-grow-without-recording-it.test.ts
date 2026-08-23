/**
 * WHY THIS SUITE EXISTS.
 *
 * Every tool description is paid for on every request of every session, and nothing was
 * counting them. The whole `tools/` set is 19166 tokens of prompt before a single tool
 * schema is serialised, and it grew one careful paragraph at a time: each edit was small,
 * each was defensible on its own, and no edit ever had to answer for the total. A budget
 * nobody measures is not a budget.
 *
 * THE RATCHET. The number recorded here IS the measurement, pinned by exact equality, so
 * a description that grows fails and a description that shrinks fails too. The second
 * half is the point: a trim that leaves its old ceiling in place hands the next author
 * the tokens it just freed, and the budget reopens without anyone deciding to reopen it.
 * Landing a trim means lowering the number, which is one line and puts the new total in
 * the diff where a reviewer sees it.
 *
 * THE CLASS, NOT THE INCIDENT. The table is compared against the row registry enumerated
 * at run time, both directions by exact equality, so a tool whose description is added
 * tomorrow is RED until someone records what it costs, and a description that is deleted
 * is RED until the row is dropped from here. That is the only way a per-member table
 * stays honest: a sweep that skips what it does not recognise cannot see the member that
 * was never recorded.
 *
 * WHAT IT DOES NOT CATCH. The count is of the template as it ships, which is what a trim
 * edits; a Handlebars block that expands differently per configuration is not measured
 * per configuration, and the JSON schema each tool serialises alongside its description
 * is not measured at all (`veyyon prompt --tools` reports both together, and the schema
 * is generated rather than written). It also says nothing about whether a description
 * still works after a trim — that is what the deepswe-bench prompt-override arm is for,
 * and a trim lands on that verdict, not on this number going down.
 */
import { describe, expect, it } from "bun:test";
import { toolsPrompts } from "@veyyon/coding-agent/prompts/tools/rows";
import { estimateTokensFromText } from "@veyyon/utils";

/**
 * What each `tools/` description costs today, in `estimateTokensFromText` tokens.
 *
 * Lower a number when a trim lands. Do not raise one without saying, in the commit, what
 * the tokens buy.
 */
const RECORDED_TOKENS: Record<string, number> = {
	"tools/apply-patch": 726,
	"tools/ask": 285,
	"tools/ast-edit": 375,
	"tools/async-result": 105,
	"tools/bash": 1516,
	"tools/browser": 1439,
	"tools/checkpoint": 165,
	"tools/debug": 414,
	"tools/eval": 1693,
	"tools/github": 410,
	"tools/goal": 162,
	"tools/search": 573,
	"tools/image-attachment-describe": 142,
	"tools/image-attachment-describe-system": 196,
	"tools/image-gen": 110,
	"tools/inspect-image": 255,
	"tools/inspect-image-system": 192,
	"tools/irc": 679,
	"tools/job": 411,
	"tools/launch": 519,
	"tools/learn": 198,
	"tools/lsp": 564,
	"tools/lsp-late-diagnostic": 83,
	"tools/manage-skill": 217,
	"tools/memory-edit": 243,
	"tools/patch": 692,
	"tools/read": 1123,
	"tools/recall": 164,
	"tools/reflect": 98,
	"tools/replace": 318,
	"tools/resolve": 104,
	"tools/retain": 103,
	"tools/rewind": 181,
	"tools/search-tool-bm25": 334,
	"tools/set-cwd": 449,
	"tools/ssh": 236,
	"tools/task": 1150,
	"tools/task-summary": 151,
	"tools/todo": 500,
	"tools/vibe-kill": 78,
	"tools/vibe-list": 77,
	"tools/vibe-send": 184,
	"tools/vibe-spawn": 247,
	"tools/vibe-turn-result": 163,
	"tools/vibe-wait": 142,
	"tools/web-search": 69,
	"tools/web-search-system": 328,
	"tools/write": 160,
};

/** The sum the recorded table claims, so the total is in the diff of any trim. */
const RECORDED_TOTAL = 18723;

const measured = new Map(Object.entries(toolsPrompts).map(([id, entry]) => [id, estimateTokensFromText(entry.text)]));

describe("the tools prompt budget", () => {
	it("measures the shipped text, not an override", () => {
		// `definePromptRows` substitutes `VEYYON_EVAL_PROMPTS` where the text is READ, which is
		// exactly the map above. A bench arm sets that variable, so a measurement taken with it
		// set is of the arm's text and would record the arm's budget as the product's.
		expect(process.env.VEYYON_EVAL_PROMPTS).toBeUndefined();
	});

	it("records exactly the descriptions that exist", () => {
		expect(Object.keys(RECORDED_TOKENS).sort()).toEqual([...measured.keys()].sort());
	});

	it.each([...Object.keys(RECORDED_TOKENS)].sort())("costs the recorded tokens for %s", id => {
		expect(measured.get(id)).toBe(RECORDED_TOKENS[id]);
	});

	it("costs the recorded total for the whole set", () => {
		const total = [...measured.values()].reduce((sum, tokens) => sum + tokens, 0);

		expect(total).toBe(RECORDED_TOTAL);
		expect(Object.values(RECORDED_TOKENS).reduce((sum, tokens) => sum + tokens, 0)).toBe(RECORDED_TOTAL);
	});
});
