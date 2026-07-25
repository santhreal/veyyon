import { describe, expect, test } from "bun:test";
import { AGENT_PROMPTS } from "@veyyon/agent-core/prompts/registry";

/**
 * The two compaction strategies must stay two different things.
 *
 * They had converged: both prompts demanded the same section list, and the
 * summary prompt literally opened "summarize the conversation above into a
 * structured handoff summary". A counterfactual on session 019f974f (one
 * `prepareCompaction()` shared by four arms, tokensBefore=221568) measured what
 * that cost. The summary prompt buried its evidence requirement in a trailing
 * sentence, directly after "Sections MUST be kept concise", and
 * gemini-3.6-flash's summary carried ZERO runnable gate commands and 2
 * verification numbers. The handoff prompt, which asks for "commands run" and
 * "test results" in an explicit list, got 7 gate commands out of the same model
 * on the same input.
 *
 * After the prompts were split by contract, gemini's summary carried 7, 7, and 8
 * gate commands across three runs (mean 7.3, up from 0) for +21 characters, while
 * still covering 9/9 of the items the session actually closed.
 *
 * These tests pin the prompt contracts that produced that. They assert structure,
 * not model output, so they stay deterministic.
 */

describe("compaction strategy prompts state distinct contracts", () => {
	/**
	 * The summary strategy continues in the SAME session, so the recent turns
	 * survive next to the summary. Without saying so, the model rewrites what is
	 * already in context and spends its budget twice.
	 */
	test("the summary prompt tells the model the session continues", () => {
		expect(AGENT_PROMPTS["compaction/compaction-summary"].text).toContain("SAME session");
		expect(AGENT_PROMPTS["compaction/compaction-summary"].text).toMatch(/do not restate/i);
		// It must NOT describe itself as a handoff; that framing is what made the
		// two strategies produce one document.
		expect(AGENT_PROMPTS["compaction/compaction-summary"].text).not.toMatch(/structured handoff summary/i);
	});

	/**
	 * The handoff strategy starts a NEW session where nothing survives, so it is
	 * the only one that must carry cold-restart state.
	 */
	test("the handoff prompt tells the model nothing survives and demands restart state", () => {
		expect(AGENT_PROMPTS["compaction/handoff-document"].text).toContain("NEW session");
		expect(AGENT_PROMPTS["compaction/handoff-document"].text).toMatch(/nothing from this conversation survives/i);
		expect(AGENT_PROMPTS["compaction/handoff-document"].text).toMatch(/working directory/i);
		expect(AGENT_PROMPTS["compaction/handoff-document"].text).toMatch(/exact next command/i);
	});

	/** Restart state belongs to handoff alone, or the two converge again. */
	test("only the handoff prompt asks for cold-restart state", () => {
		expect(AGENT_PROMPTS["compaction/compaction-summary"].text).not.toMatch(/exact next command/i);
		expect(AGENT_PROMPTS["compaction/compaction-summary"].text).not.toMatch(/starts cold/i);
	});
});

describe("both strategy prompts demand verification evidence", () => {
	/**
	 * The measured defect: evidence was requested vaguely ("relevant tool outputs
	 * or command results") and buried after a competing brevity instruction. Both
	 * prompts must now ask for the three things that cannot be reconstructed from
	 * a paraphrase.
	 */
	test.each([
		["summary", AGENT_PROMPTS["compaction/compaction-summary"].text],
		["handoff", AGENT_PROMPTS["compaction/handoff-document"].text],
	])("%s prompt asks for commands, result numbers, and exact failures", (_name, promptText) => {
		expect(promptText).toMatch(/commands run/i);
		expect(promptText).toMatch(/pass\/fail counts/i);
		expect(promptText).toMatch(/run ids/i);
		expect(promptText).toMatch(/exact error text/i);
	});

	/**
	 * "Be concise" and "keep every command" pull in opposite directions. The
	 * summary prompt used to place them one sentence apart with no precedence,
	 * and the model resolved it by dropping the commands. The precedence is now
	 * explicit and must stay that way.
	 */
	test("the summary prompt resolves concision against evidence explicitly", () => {
		expect(AGENT_PROMPTS["compaction/compaction-summary"].text).toMatch(/prose is where you are concise/i);
		expect(AGENT_PROMPTS["compaction/compaction-summary"].text).toMatch(/evidence is where you are complete/i);
		expect(AGENT_PROMPTS["compaction/compaction-summary"].text).toMatch(/drop the prose and keep the evidence/i);
	});
});

describe("the overarching goal outlives the task in front of it", () => {
	/**
	 * The goal used to be a single field, so the model wrote whichever goal was
	 * most concrete and most recent: on session 019f974f the Goal section held the
	 * current sub-task and never the standing objective the session sat inside.
	 * That is not decay across compactions, it is wrong at the FIRST one, after
	 * which every later cycle faithfully carries the wrong thing forward.
	 *
	 * All three prompts now ask for the two separately, because they change at
	 * different speeds and a single field lets the fast one win.
	 */
	test.each([
		["summary", AGENT_PROMPTS["compaction/compaction-summary"].text],
		["handoff", AGENT_PROMPTS["compaction/handoff-document"].text],
		["update", AGENT_PROMPTS["compaction/compaction-update-summary"].text],
	])("%s prompt states the overarching goal is never dropped", (_name, promptText) => {
		expect(promptText).toMatch(/overarching goal/i);
		expect(promptText).toMatch(/never dropped/i);
	});

	/** One shape across all three, or the strategies disagree about what a goal is. */
	test.each([
		["summary", AGENT_PROMPTS["compaction/compaction-summary"].text],
		["handoff", AGENT_PROMPTS["compaction/handoff-document"].text],
		["update", AGENT_PROMPTS["compaction/compaction-update-summary"].text],
	])("%s prompt separates the overarching goal from the current task", (_name, promptText) => {
		expect(promptText).toContain("Current task:");
		expect(promptText).toMatch(/carried forward unless the user changed it/i);
	});

	/**
	 * The update prompt runs on every compaction after the first, and it licenses
	 * the model to drop anything no longer relevant. Without an explicit carve-out
	 * the standing objective is exactly the kind of thing that reads as stale.
	 */
	test("the update prompt exempts the goal from its own removal license", () => {
		expect(AGENT_PROMPTS["compaction/compaction-update-summary"].text).toMatch(
			/remove anything no longer relevant, except the overarching goal/i,
		);
	});
});

describe("repository state is specific enough to resume from", () => {
	/**
	 * A branch name alone does not say where the work started or whether any of it
	 * is saved. Reading codex and gemini output side by side on session 019f974f
	 * made the gap concrete: codex volunteered `main` at `a081c256c3`, a clean
	 * initial tree, and "No commit has been made during this session", while
	 * gemini gave the branch and nothing else. Asking for the commit explicitly
	 * closed that gap on the cheaper model.
	 *
	 * Whether anything was committed is the load-bearing part: it tells the next
	 * session whether the work exists anywhere but the working tree.
	 */
	test.each([
		["summary", AGENT_PROMPTS["compaction/compaction-summary"].text],
		["handoff", AGENT_PROMPTS["compaction/handoff-document"].text],
		["update", AGENT_PROMPTS["compaction/compaction-update-summary"].text],
	])("%s prompt asks for the HEAD commit and whether anything was committed", (_name, promptText) => {
		expect(promptText).toMatch(/HEAD commit/i);
		expect(promptText).toMatch(/whether anything was committed this session/i);
	});

	/**
	 * Repository state is requested only where it exists. Making it unconditional
	 * turns it into a field to fill, and a session that is not in a repository
	 * gets an invented branch, which is the same fabrication failure the commands
	 * rule exists to prevent.
	 */
	test.each([
		["summary", AGENT_PROMPTS["compaction/compaction-summary"].text],
		["handoff", AGENT_PROMPTS["compaction/handoff-document"].text],
	])("%s prompt makes repository state conditional, not mandatory", (_name, promptText) => {
		expect(promptText).toMatch(/where the work is version controlled/i);
	});
});

describe("both strategies can record what is stopping progress", () => {
	/**
	 * The summary prompt had a `Blocked` section and the handoff prompt did not,
	 * which is backwards: handoff is the one whose reader starts cold with nothing
	 * but the document, so a blocker it cannot see is a blocker it rediscovers by
	 * walking into it.
	 *
	 * Adding the section produced exactly the class of fact that cannot be
	 * re-derived from the repository: "Triggering or mutating GitHub requires
	 * explicit approval", and a marketplace listing needing a repository-owner UI
	 * action. Neither is visible in any file the next session could read.
	 */
	test.each([
		["summary", AGENT_PROMPTS["compaction/compaction-summary"].text],
		["handoff", AGENT_PROMPTS["compaction/handoff-document"].text],
		["update", AGENT_PROMPTS["compaction/compaction-update-summary"].text],
	])("%s prompt has a Blocked section", (_name, promptText) => {
		expect(promptText).toContain("### Blocked");
	});

	/**
	 * Handoff keeps `Pending` as well. Summary is injected beside the live turns
	 * where not-yet-started work is still visible; handoff replaces everything, so
	 * it is the only one that has to carry work nobody has touched yet.
	 */
	test("only the handoff prompt asks for not-yet-started work", () => {
		expect(AGENT_PROMPTS["compaction/handoff-document"].text).toContain("### Pending");
		expect(AGENT_PROMPTS["compaction/compaction-summary"].text).not.toContain("### Pending");
	});
});
