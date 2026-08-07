import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AGENT_PROMPTS } from "@veyyon/agent-core/prompts/registry";

/**
 * WHAT THIS FILE REPLACED, AND WHY IT HAD TO BE REPLACED.
 *
 * The previous version of this file asserted prompt text that existed in no
 * shipped prompt: not in the veyyon prompt at HEAD, not in the upstream prompt
 * that replaced it. It required "## User Requirements", "## Pending User
 * Question", "successful commands that teach nothing", "recent turns remain
 * beside the summary verbatim", and a "runtime canonical `<continuity-state>`
 * block". Every one of those returns zero matches against both prompt
 * generations, so fourteen assertions were red before the swap and stayed red
 * after it, describing a design nobody ever wrote. They are deleted rather than
 * repaired: a test that has never once matched the artifact it names is not
 * coverage of anything.
 *
 * What is here instead asserts the prompts that actually ship.
 */

const summaryPrompt = AGENT_PROMPTS["compaction/compaction-summary"].text;
const updatePrompt = AGENT_PROMPTS["compaction/compaction-update-summary"].text;
const contextPrompt = AGENT_PROMPTS["compaction/compaction-summary-context"].text;
const handoffPrompt = AGENT_PROMPTS["compaction/handoff-document"].text;

/** Every `##`/`###` heading, in document order. */
function sectionHeadings(promptText: string): string[] {
	return promptText.split("\n").filter(line => /^#{2,3} /.test(line));
}

describe("the three compaction prompts are the operator-ordered upstream text", () => {
	/**
	 * The operator ordered these three files replaced with oh-my-pi's byte for
	 * byte, on the measurement that upstream scores higher on their long-run
	 * evals. That order is the contract, so the bytes are the assertion.
	 *
	 * These digests were taken from oh-my-pi at commit da6e80b3b (2026-07-30),
	 * `packages/agent/src/compaction/prompts/`, and independently reproduce the
	 * digests of the files in this repository.
	 *
	 * A FAILURE HERE IS NOT A TEST TO UPDATE. It means someone edited an
	 * operator-ordered prompt. Veyyon's dominant defect class is a subsystem
	 * that keeps compiling while its behavior is quietly replaced, and prompt
	 * text is the least visible place that can happen: nothing type-checks it,
	 * nothing crashes, and the only symptom is worse summaries. Restore the
	 * bytes, or get the operator to approve the deviation and then update the
	 * digest in the same change.
	 */
	test.each([
		["compaction-summary", summaryPrompt, 1206, "36f4e78445b7103273455546325a50e6ffcd23277ab0a79a9c3d1bfef2a7ec4d"],
		[
			"compaction-update-summary",
			updatePrompt,
			1633,
			"2b48e116ff167ca7b5dc095cab580f547089eb3a48ef0859f160eef7417b7bbe",
		],
		[
			"compaction-summary-context",
			contextPrompt,
			285,
			"c56e37f7a32354807317289e173960b260c01b05a20caeb875ee90f81e584d32",
		],
	])("%s is upstream verbatim", (_name, promptText, bytes, digest) => {
		// Byte length is asserted alongside the digest so a failure reports how
		// far the text moved, not only that it moved.
		expect(Buffer.byteLength(promptText)).toBe(bytes);
		expect(createHash("sha256").update(promptText).digest("hex")).toBe(digest);
	});
});

describe("what both compaction prompts must guarantee", () => {
	/**
	 * The one instruction that stops a summarizer paraphrasing. A path, a symbol,
	 * or an error string that gets reworded costs the next turn a rediscovery
	 * round trip, and a reworded error string is worse than a missing one because
	 * it reads as observed fact.
	 */
	test.each([
		["initial", summaryPrompt],
		["iterative", updatePrompt],
	])("%s prompt requires identifiers preserved exactly", (_name, promptText) => {
		expect(promptText).toContain("preserve exact file paths, function names");
		expect(promptText).toContain("error messages");
		expect(promptText).toContain("repository state changes (branch, uncommitted changes)");
	});

	/**
	 * An unanswered question to the user cannot be reconstructed from repository
	 * state: the user is the only place the answer lives, and a summarizer that
	 * paraphrases it into a next step turns a blocked session into one that
	 * silently proceeds on a guess. Both prompts carry the clause, in their own
	 * wording, so each is asserted against its own sentence rather than a
	 * lowest-common-denominator regex that would pass on either one alone.
	 */
	test("the initial prompt preserves a pending question verbatim", () => {
		expect(summaryPrompt).toContain(
			'IMPORTANT: If the conversation ends with an unanswered question or a request awaiting user response (e.g., "Please run command and paste output"), you MUST preserve that exact question/request.',
		);
	});

	test("the iterative prompt files a newly pending question into Critical Context", () => {
		expect(updatePrompt).toContain(
			"IMPORTANT: If the new messages end with an unanswered question or request to the user, you MUST add it to Critical Context (replacing any previous pending question if answered).",
		);
	});

	/**
	 * The summarizer's output is written straight into the compaction entry as
	 * the summary. A model that opens with "Sure, here is the summary:" puts that
	 * sentence into permanent session history, where every later turn reads it as
	 * part of the recovered state.
	 */
	test.each([
		["initial", summaryPrompt],
		["iterative", updatePrompt],
	])("%s prompt forbids conversational output", (_name, promptText) => {
		expect(promptText).toContain("You MUST output only the structured summary; you NEVER include extra text.");
	});

	/**
	 * Iterative compaction feeds its own previous output back in. If the two
	 * prompts disagree about the section list, every compaction cycle drops the
	 * sections the update prompt forgot to name, and the loss compounds silently
	 * across a long session because each cycle's input already looks complete.
	 */
	test("the initial and iterative prompts declare the same sections in the same order", () => {
		expect(sectionHeadings(updatePrompt)).toEqual(sectionHeadings(summaryPrompt));
		expect(sectionHeadings(summaryPrompt)).toEqual([
			"## Goal",
			"## Constraints & Preferences",
			"## Progress",
			"### Done",
			"### In Progress",
			"### Blocked",
			"## Key Decisions",
			"## Next Steps",
			"## Critical Context",
			"## Additional Notes",
		]);
	});

	/**
	 * `generateSummary` selects the iterative prompt exactly when it has a
	 * previous summary to pass, and only then emits the `<previous-summary>`
	 * block (`buildSummaryPrompt` in src/compaction/compaction.ts). An initial
	 * prompt that referred to that block would send the model looking for a
	 * section the builder did not write.
	 */
	test("only the iterative prompt references the previous-summary block", () => {
		expect(updatePrompt).toContain("<previous-summary>");
		expect(summaryPrompt).not.toContain("<previous-summary>");
	});
});

describe("automatic compaction and explicit handoff stay distinct", () => {
	/**
	 * `/handoff` starts a NEW session where nothing survives, so its document
	 * alone must carry cold-restart state.
	 *
	 * The converse assertion, that the automatic-compaction prompt does NOT
	 * describe a cold restart, is deliberately absent. Upstream's summary prompt
	 * opens "structured handoff summary for another LLM to resume the task",
	 * which is false for how either fork actually compacts: both keep a 10000
	 * token recent tail (`keepRecentTokens`) and inject the summary in front of
	 * it in the SAME session. That mismatch is escalated to the operator as a
	 * candidate deviation from the ordered text, and no test here presumes the
	 * outcome in either direction.
	 */
	test("the handoff prompt carries cold-restart state", () => {
		expect(handoffPrompt).toContain("NEW session");
		expect(handoffPrompt).toMatch(/nothing from this conversation survives/i);
		expect(handoffPrompt).toMatch(/working directory/i);
		expect(handoffPrompt).toMatch(/exact next command/i);
	});

	/**
	 * The durable objective and the mutable current task change at different
	 * rates, so a concrete subtask must not overwrite the user's goal. Only the
	 * handoff prompt still draws that line: the upstream summary prompts have one
	 * undifferentiated `## Goal`. That gap is part of the same escalation.
	 */
	test("the handoff prompt separates the overarching goal from the current task", () => {
		expect(handoffPrompt).toMatch(/overarching goal/i);
		expect(handoffPrompt).toContain("Current task:");
		expect(handoffPrompt).toMatch(/carried forward unless the user changed it/i);
	});

	/**
	 * Session-owned jobs are cancelled by a replacement-session handoff. Claiming
	 * they remain live would make the next session wait on work that cannot
	 * finish.
	 */
	test("handoff distinguishes cancelled jobs from independently persistent processes", () => {
		expect(handoffPrompt).toMatch(/session-owned async jobs are cancelled/i);
		expect(handoffPrompt).toMatch(/never say they remain running/i);
		expect(handoffPrompt).toMatch(/independently persistent processes/i);
	});

	/**
	 * A blocker changes what can safely happen next, so it belongs in every
	 * continuation form, even though pending untouched work belongs only to
	 * handoff.
	 */
	test.each([
		["initial", summaryPrompt],
		["iterative", updatePrompt],
		["handoff", handoffPrompt],
	])("%s prompt retains current blockers", (_name, promptText) => {
		expect(promptText).toContain("### Blocked");
	});
});
