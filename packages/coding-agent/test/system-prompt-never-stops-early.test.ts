/**
 * The prompt must still tell the model not to stop with work left.
 *
 * WHY THIS SUITE EXISTS. Upstream oh-my-pi states the same prohibition twice, once inside
 * `<contract>` and once in the closing `<critical>` block, and this fork rendered neither. The
 * removal was deliberate: the 2026-07-27 entry in `system-prompt-cached-prefix-stability.test.ts`
 * calls both lines redundant against "the `<critical>` line saying there is no stopping condition
 * other than completion". No such line is in `<critical>`. It lives in
 * `src/prompts/session/project-prompt.md`, which is the SUBAGENT prompt, so the main-session prompt
 * lost two anti-early-stop instructions in exchange for text it does not carry.
 *
 * A digest pin cannot catch that class on its own: it says the bytes moved, never which sentence
 * left. So these assert the SENTENCES against the composed block 0 that a session actually sends,
 * not the existence of a statement file. Several statements in this repo have existed and never
 * reached a model; a file check would pass for every one of them.
 *
 * Re-delete any of the four rows, or gate one, and the matching case fails naming the line.
 */
import { describe, expect, it } from "bun:test";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";

const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

type BuildOptions = Parameters<typeof buildSystemPrompt>[0];

/** Host-independent options, matching the cached-prefix fixture so the two suites measure one prompt. */
const optionsWithTools = (toolNames: string[]): BuildOptions =>
	({
		toolNames,
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
	}) as BuildOptions;

const blockZero = async (toolNames: string[]): Promise<string> => {
	const { systemPrompt } = await buildSystemPrompt(optionsWithTools(toolNames));
	return systemPrompt[0] as string;
};

/** No `task`, no `todo`: the reduced set that must still carry every unconditional prohibition. */
const MINIMAL_TOOLS = ["read", "write", "bash"];

const NO_PARTIAL_YIELD =
	"- NEVER yield unless the deliverable is complete. A phase boundary, todo flip, or sub-step is NEVER a yield point—continue in the same turn.";
const NEVER_STOP_EARLY =
	"- NEVER yield while actionable work remains. A phase boundary, todo flip, or sub-step is NEVER a stopping point—continue in the same turn.";

describe("the composed prompt forbids stopping with work left", () => {
	/**
	 * Unconditional means unconditional. A session with three tools and no subagents still must not
	 * stop mid-deliverable, so the reduced tool set is the fixture: a gate added later would pass a
	 * full-tool assertion and reintroduce exactly the hole this suite closes.
	 */
	it.each([
		["no-partial-yield", NO_PARTIAL_YIELD],
		["no-punting", "- NEVER punt half-solved work back."],
		["verification-source", "Tool results are THE verification."],
		["never-stop-early", NEVER_STOP_EARLY],
	])("carries %s verbatim at a reduced tool set", async (_id, sentence) => {
		expect(await blockZero(MINIMAL_TOOLS)).toContain(sentence);
	});

	/**
	 * Both prohibitions, not one. They differ in what they forbid: the contract line bans yielding an
	 * incomplete deliverable, the closing line bans yielding while anything actionable is left, and a
	 * run can violate the second while believing it satisfied the first. Upstream states both; a
	 * later "these say the same thing" trim is the failure mode that produced this suite.
	 */
	it("states the prohibition in both positions rather than once", async () => {
		const rendered = await blockZero(MINIMAL_TOOLS);
		expect(rendered.indexOf(NO_PARTIAL_YIELD)).toBeGreaterThan(-1);
		expect(rendered.indexOf(NEVER_STOP_EARLY)).toBeGreaterThan(rendered.indexOf(NO_PARTIAL_YIELD));
	});

	/**
	 * Position is part of the instruction. The final slot of the cached prefix is the last thing read
	 * before the conversation, and it is why upstream repeats the line there instead of only in the
	 * contract. Appending any statement after this one silently takes that slot away, which no digest
	 * or containment check would report.
	 */
	it("ends block 0 with the no-early-stop block and nothing after it", async () => {
		const rendered = await blockZero(MINIMAL_TOOLS);
		const tail = rendered.trimEnd();

		expect(tail.endsWith(`<never-stop-early>\n${NEVER_STOP_EARLY}\n</never-stop-early>`)).toBe(true);
	});
});

describe("the todo batching rule follows the todo tool", () => {
	/**
	 * The one conditioned row of the five, and the condition is load-bearing in both directions.
	 * Present, it removes a wasted round trip per todo op. Absent from a session with no todo tool,
	 * it stops the prompt spending tokens every turn on a tool the model cannot call.
	 *
	 * The tool name is asserted as the RENDERED name rather than as `{{toolRefs.todo}}`, because an
	 * unrendered handlebars token in a shipped prompt is the defect the interpolation exists to
	 * prevent.
	 */
	it("names the todo tool only when the session has one", async () => {
		const withoutTodo = await blockZero(MINIMAL_TOOLS);
		const withTodo = await blockZero([...MINIMAL_TOOLS, "todo"]);

		expect(withoutTodo).not.toContain("Todo calls NEVER travel alone");
		expect(withTodo).toContain(
			"- Todo calls NEVER travel alone: batch every `todo` op into the same message as the turn's real tool calls " +
				"(`init` alongside the first reads/edits, `done` alongside the next action or final verification). " +
				"An assistant turn whose only tool call is `todo` wastes a full round trip.",
		);
	});
});
