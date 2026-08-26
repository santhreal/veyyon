/**
 * WHY THIS SUITE DEFENDS SHORTHAND TREATMENT TELEMETRY AND HEADROOM BOUNDS.
 *
 * Argot shorthand efficacy depends on verified treatment delivery (preamble taught
 * and vocabulary loaded), sigil detection across both prose and tool calls,
 * normalized tool-call distributions, and empirical effect-size headroom analysis
 * that bounds whether a benchmark suite has enough typeable handle mass to distinguish
 * real savings from within-task noise.
 *
 * What this does not catch: model-side prompt caching artifacts beyond reported token metrics.
 */

import { describe, expect, test } from "bun:test";
import { ARGOT_PREAMBLE, renderPreamble } from "argot";
import {
	ARGOT_PREAMBLE_HEADING,
	collectEmittedText,
	encodeHeadroom,
	interpretEncodeArm,
	systemPromptTeachesArgot,
} from "../../../src/suites/deep-swe/src/aggregate/encode-probe";
import { renderReport } from "../../../src/suites/deep-swe/src/aggregate/report-render";
import {
	ceilingBelowNoise,
	relativeSpreadPct,
	withinTaskSpreadPct,
} from "../../../src/suites/deep-swe/src/aggregate/stats";
import type { ArmResult } from "../../../src/suites/deep-swe/src/aggregate/types";
import {
	blockContainsSigil,
	OBSERVED_TYPEABLE_EMISSION_RATE,
	tallyUsage,
	typeableHandleMass,
} from "../../../src/suites/deep-swe/src/aggregate/usage";
import { res } from "./aggregate-test-helpers";

describe("blockContainsSigil — encode is detected in tool calls, not just prose", () => {
	// The argot preamble tells the model to write a handle "in prose, a command, or
	// a diff". On a coding agent most output is tool calls (shell commands, edit
	// diffs), so a probe that scanned only text blocks would miss the handles that
	// actually appear and could read a heavy-encode arm as "0 encoded", falsely
	// concluding the treatment never fired. These tests lock the tool-call scan in.

	test("a text block containing § counts", () => {
		// The obvious case: a handle written in the assistant's prose.
		expect(blockContainsSigil({ type: "text", text: "edit §dbconn now" })).toBe(true);
	});

	test("a text block with no § does not count", () => {
		expect(blockContainsSigil({ type: "text", text: "no handles here" })).toBe(false);
	});

	test("a handle inside a tool call's command argument counts — the regression this fixes", () => {
		// A shell command referencing a path by handle. The old text-only probe
		// returned false here; that is exactly the undercount being closed.
		const block = { type: "toolCall", name: "bash", arguments: { command: "cat §dbconn" } };
		expect(blockContainsSigil(block)).toBe(true);
	});

	test("a handle inside a tool call's diff argument counts", () => {
		const block = {
			type: "toolCall",
			name: "apply_patch",
			arguments: { patch: "--- a/§dbconn\n+++ b/§dbconn\n" },
		};
		expect(blockContainsSigil(block)).toBe(true);
	});

	test("a tool call whose arguments hold no § does not count", () => {
		const block = { type: "toolCall", name: "bash", arguments: { command: "ls -la" } };
		expect(blockContainsSigil(block)).toBe(false);
	});

	test("a § nested deep in the arguments object still counts (serialized scan)", () => {
		const block = {
			type: "toolCall",
			name: "multi_edit",
			arguments: { edits: [{ path: "clean" }, { path: "§dbconn" }] },
		};
		expect(blockContainsSigil(block)).toBe(true);
	});

	test("a custom sigil is honored, and the default § is then not matched", () => {
		const block = { type: "toolCall", name: "bash", arguments: { command: "cat ¶dbconn" } };
		expect(blockContainsSigil(block, "¶")).toBe(true);
		expect(blockContainsSigil(block)).toBe(false);
	});

	test("non-object and null blocks are sigil-free, never throw", () => {
		expect(blockContainsSigil(null)).toBe(false);
		expect(blockContainsSigil(undefined)).toBe(false);
		expect(blockContainsSigil("§ raw string is not a block")).toBe(false);
	});

	test("a non-serializable (cyclic) arguments object is treated as sigil-free, not thrown", () => {
		// A read-only probe must never crash the parse; a cyclic object cannot hold
		// a plain countable handle string anyway.
		const cyclic: Record<string, unknown> = { command: "x" };
		cyclic.self = cyclic;
		const block = { type: "toolCall", name: "bash", arguments: cyclic };
		expect(blockContainsSigil(block)).toBe(false);
	});
});

describe("tallyUsage — a tool invocation is counted once, not once per call and once per result", () => {
	// The bug this locks out: one tool use shows up in the transcript twice — as a
	// toolCall block on the assistant message, and as a toolResult message. The old
	// parser counted both, doubling every entry in the tool distribution (40 real
	// eval calls reported as 80). tallyUsage counts only the assistant invocations.

	test("a call+result pair for the same tool counts as ONE, not two", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "toolCall", name: "eval", arguments: { code: "1+1" } }],
			},
			{ role: "toolResult", toolName: "eval", content: [{ type: "text", text: "2" }] },
		];
		const u = tallyUsage(messages);
		expect(u.toolCalls).toEqual({ eval: 1 });
	});

	test("counts match the model's real invocations across a mixed session", () => {
		// Two eval calls and one read call, each with its paired result. The doubled
		// parser would have reported eval:4, read:2.
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "eval", arguments: {} }] },
			{ role: "toolResult", toolName: "eval", content: [] },
			{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] },
			{ role: "toolResult", toolName: "read", content: [] },
			{ role: "assistant", content: [{ type: "toolCall", name: "eval", arguments: {} }] },
			{ role: "toolResult", toolName: "eval", content: [] },
		];
		expect(tallyUsage(messages).toolCalls).toEqual({ eval: 2, read: 1 });
	});

	test("argot_load is counted from the invocation, consistent with the tool distribution", () => {
		// The treatment probe (argotLoadCalls) and the distribution must agree: both
		// derive from the same assistant toolCall block, so a load is 1 in both.
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "argot_load", arguments: { folder: "pkg" } }] },
			{ role: "toolResult", toolName: "argot_load", content: [] },
		];
		const u = tallyUsage(messages);
		expect(u.argotLoadCalls).toBe(1);
		expect(u.toolCalls.argot_load).toBe(1);
	});

	test("sums token usage from assistant messages and ignores non-assistant roles", () => {
		const messages = [
			{
				role: "assistant",
				usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, cost: { total: 0.01 } },
				content: [],
			},
			{ role: "toolResult", toolName: "read", content: [] },
			{
				role: "assistant",
				usage: { input: 50, output: 10, cacheRead: 2, cacheWrite: 0, cost: { total: 0.005 } },
				content: [],
			},
		];
		const u = tallyUsage(messages);
		expect(u.inputTokens).toBe(150);
		expect(u.outputTokens).toBe(30);
		expect(u.cacheTokens).toBe(10); // (5+3) + (2+0)
		expect(u.costUsd).toBeCloseTo(0.015, 12);
	});

	test("counts an assistant message as encoded when a handle rides in a tool call, not just prose", () => {
		// Ties tallyUsage to blockContainsSigil: a handle in a shell command counts.
		const messages = [
			{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "cat §dbconn" } }] },
			{ role: "assistant", content: [{ type: "text", text: "no handle here" }] },
		];
		expect(tallyUsage(messages).assistantMsgsWithSigil).toBe(1);
	});

	/**
	 * Cache reads and cache writes must survive the tally as separate numbers.
	 *
	 * They were summed into one `cacheTokens` field, and that single field cannot
	 * be priced: a read costs 0.075/M and a write 0.3833/M, a factor of five, so
	 * an arm that turns reads into writes gets five times more expensive while
	 * the summed column does not move at all. That is the exact regression the
	 * cost table exists to catch, and it can only be caught if the split survives
	 * from the session file to the row. `cacheTokens` is still their sum, for the
	 * older records and callers that read it.
	 */
	test("keeps cache reads and cache writes separate, and their sum", () => {
		const messages = [
			{ role: "assistant", usage: { input: 10, output: 5, cacheRead: 1000, cacheWrite: 200 }, content: [] },
			{ role: "assistant", usage: { input: 20, output: 7, cacheRead: 3000, cacheWrite: 0 }, content: [] },
		];
		const u = tallyUsage(messages);
		expect(u.cacheReadTokens).toBe(4000);
		expect(u.cacheWriteTokens).toBe(200);
		expect(u.cacheTokens).toBe(4200);
		expect(u.inputTokens).toBe(30);
		expect(u.outputTokens).toBe(12);
	});

	/**
	 * A session whose messages report reads but no `cacheWrite` field at all must
	 * tally a write of zero, not `NaN`. Providers omit the field when nothing was
	 * written, and a `NaN` here would propagate into the priced total and render
	 * the whole cost table unusable from one malformed line.
	 */
	test("treats an absent cacheWrite field as zero, not NaN", () => {
		const u = tallyUsage([{ role: "assistant", usage: { input: 5, output: 1, cacheRead: 99 }, content: [] }]);
		expect(u.cacheWriteTokens).toBe(0);
		expect(u.cacheReadTokens).toBe(99);
		expect(Number.isNaN(u.cacheTokens)).toBe(false);
	});

	test("an empty session tallies to all-zero, never throws", () => {
		const u = tallyUsage([]);
		expect(u).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0,
			argotLoadCalls: 0,
			assistantMsgsWithSigil: 0,
			toolCalls: {},
		});
	});
});

describe("systemPromptTeachesArgot — the authoritative post-run encode-fired probe", () => {
	// Why this exists: the pre-run allowlist guard matches the REQUESTED --model, but
	// the runtime resolves that id through the catalog to a different logical id before
	// argot's gate runs. So an encode arm can pass the pre-run guard and still run
	// decode-only. This probe reads the actual system prompt the model was given, which
	// reflects the model AFTER resolution — the only signal that catches a silent
	// decode-only degrade. A real full-arm smoke reproduced exactly that: requested
	// google-antigravity/gemini-3.6-flash resolved to gemini-3.5-flash, off the
	// [..., gemini-3.6-flash, ...] allowlist, so the preamble was never taught.

	test("the marker is argot's OWN preamble heading, so it cannot drift from the runtime", () => {
		// ARGOT_PREAMBLE_HEADING must be the first line of argot's rendered preamble,
		// not a hand-copied string that could silently fall out of sync with what the
		// harness injects. If argot renames the heading, this test moves with it.
		expect(ARGOT_PREAMBLE_HEADING).toBe(ARGOT_PREAMBLE.split("\n")[0]);
		expect(ARGOT_PREAMBLE_HEADING).toBe("## Project shorthand (Argot)");
	});

	test("true when the system prompt carries the real teaching preamble (tools variant)", () => {
		// sdk.ts injects renderPreamble({ tools: true }); the heading is identical to the
		// default variant, so the probe fires on the exact text the coding agent embeds.
		const prompt = `You are a helpful agent.\n\n${renderPreamble({ tools: true })}\n\nMore rules.`;
		expect(systemPromptTeachesArgot(prompt)).toBe(true);
	});

	test("true for the no-tools preamble variant as well", () => {
		const prompt = `preamble:\n${renderPreamble({ tools: false })}`;
		expect(systemPromptTeachesArgot(prompt)).toBe(true);
	});

	test("false for a real 83k-char system prompt that never taught encoding (the smoke bug)", () => {
		// The decode arm — and the BROKEN full arm — produce a full system prompt with
		// every rule EXCEPT the argot preamble. A long prompt that merely mentions
		// "argot" or "shorthand" elsewhere must not be mistaken for the taught treatment.
		const prompt = `${"lorem ipsum ".repeat(7000)}\nargot_load is a tool. shorthand exists.`;
		expect(systemPromptTeachesArgot(prompt)).toBe(false);
	});

	test("false on an empty prompt", () => {
		expect(systemPromptTeachesArgot("")).toBe(false);
	});
});

describe("renderReport — Argot treatment applied? surfaces `preamble taught` authoritatively", () => {
	const STAMP = "2026-07-24T00:00:00.000Z";
	// The column that would have caught the inert full-arm run at a glance: an encode
	// arm whose preamble never reached the model reads `0/N`, so a reader knows every
	// token delta against it is meaningless before trusting the efficiency section.

	test("an encode arm that never taught the preamble reads 0/N (the silent decode-only degrade)", () => {
		const results: ArmResult[] = [
			res({
				arm: "full",
				task: "t1",
				reward: 1,
				argotLoadCalls: 0,
				assistantMsgsWithSigil: 0,
				argotPreamblePresent: false,
			}),
			res({
				arm: "full",
				task: "t2",
				reward: 0,
				argotLoadCalls: 0,
				assistantMsgsWithSigil: 0,
				argotPreamblePresent: false,
			}),
		];
		const report = renderReport(results, "google-antigravity/gemini-3.5-flash", STAMP, 1);
		expect(report).toContain("## Argot treatment applied? (per arm)");
		// arm | OK runs | preamble taught | ... => full ran 2 OK trials, taught 0 of 2.
		expect(report).toContain("| full | 2 | 0/2 |");
	});

	test("an encode arm that taught the preamble on every trial reads N/N", () => {
		const results: ArmResult[] = [
			res({
				arm: "full",
				task: "t1",
				reward: 1,
				argotLoadCalls: 1,
				assistantMsgsWithSigil: 3,
				argotPreamblePresent: true,
			}),
			res({
				arm: "full",
				task: "t2",
				reward: 1,
				argotLoadCalls: 1,
				assistantMsgsWithSigil: 5,
				argotPreamblePresent: true,
			}),
		];
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("| full | 2 | 2/2 |");
	});

	test("reads `unknown` when no trial's preamble presence could be determined", () => {
		// argotPreamblePresent null (unreadable sessions) but argot telemetry present, so
		// the section still renders; the taught cell must say unknown, not a false 0/0.
		const results: ArmResult[] = [
			res({
				arm: "decode",
				task: "t1",
				reward: 1,
				argotLoadCalls: 2,
				assistantMsgsWithSigil: 0,
				argotPreamblePresent: null,
			}),
		];
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("| decode | 1 | unknown |");
	});
});

describe("renderReport — tool call distribution is normalized per completed run, not raw totals", () => {
	const STAMP = "2026-07-24T00:00:00.000Z";

	test("two arms with identical per-run tool use read EQUAL even when one arm errored more", () => {
		// The bias this locks out: the table used to print RAW per-arm sums. Arm `a`
		// completes 3 runs (6 read calls total) and arm `b` completes 2 runs + 1 error (4
		// read calls total). Raw sums would show 6 vs 4 and read as "b streamlined its
		// tools" when b merely ran one fewer sample. Dividing by each arm's completed-run
		// count makes both read 2.00 — the truth — and the count is disclosed as n.
		const results: ArmResult[] = [
			res({ arm: "a", task: "t1", reward: 1, toolCalls: { read: 2 } }),
			res({ arm: "a", task: "t2", reward: 1, toolCalls: { read: 2 } }),
			res({ arm: "a", task: "t3", reward: 1, toolCalls: { read: 2 } }),
			res({ arm: "b", task: "t1", reward: 1, toolCalls: { read: 2 } }),
			res({ arm: "b", task: "t2", reward: 1, toolCalls: { read: 2 } }),
			res({ arm: "b", task: "t3", error: "boom" }),
		];
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("## Tool call distribution (mean calls per completed run)");
		// Both arms used 2 read calls per run; the normalized table must say so for both,
		// and expose the differing sample counts (n=3 vs n=2) that raw totals would hide.
		expect(report).toContain("| a (n=3) | 2.00 |");
		expect(report).toContain("| b (n=2) | 2.00 |");
	});

	test("an all-errored arm shows n=0 and '—', never a divide-by-zero NaN", () => {
		// A cell with no completed run must not render NaN or Infinity from a 0 denominator;
		// it is honestly blank so the reader sees the arm produced no tool-call signal.
		const results: ArmResult[] = [
			res({ arm: "ok", task: "t1", reward: 1, toolCalls: { read: 3 } }),
			res({ arm: "dead", task: "t1", error: "boom" }),
		];
		const report = renderReport(results, "m", STAMP, 1);
		expect(report).toContain("| ok (n=1) | 3.00 |");
		expect(report).toContain("| dead (n=0) | — |");
		expect(report).not.toContain("NaN");
	});
});

describe("interpretEncodeArm — making a 0-encoded argot result interpretable", () => {
	// The bug this locks out: the first real encode-fixed run reported
	// `full: preamble taught 4/4` alongside `encoded 0/4`, and NOTHING in the
	// report could say whether argot failed, the model declined, or the corpus
	// simply had no repeated-token mass to compress. Reading a token delta from
	// that state is unsound in all three cases, but only one of them is a real
	// argot measurement. These lock the three-way disambiguation.

	test("zero handles loaded says encode was IMPOSSIBLE and the delta is not an argot measure", () => {
		// The trap case. An empty launch dictionary means the model had no handle
		// to write, so `0 encoded` is a property of the CORPUS, not of argot and
		// not of the model. The note must forbid reading the delta as "argot does
		// not help", which is exactly the wrong conclusion a bare 0 invites.
		const note = interpretEncodeArm({ arm: "full", okRuns: 4, taught: 4, handlesLoaded: 0, encoded: 0 });
		expect(note).toContain("loaded 0 handles");
		expect(note).toContain("IMPOSSIBLE");
		expect(note).toContain("NOT a measure of argot");
	});

	test("handles loaded AND taught but nothing encoded is charged to the MODEL, not the corpus", () => {
		// The genuinely interesting negative result: shorthand was in front of the
		// model and it wrote none. That is a model-adoption finding and must be
		// worded as such, never conflated with the empty-dictionary case above.
		// Note the precondition: it is only a model result once the table is proven
		// to have been TAUGHT. Loading alone never licensed this verdict.
		const note = interpretEncodeArm({
			arm: "full",
			okRuns: 4,
			taught: 4,
			handlesLoaded: 37,
			encoded: 0,
			handlesTaught: 4,
			handlesTaughtKnown: 4,
		});
		expect(note).toContain("37 handles were loaded AND taught in 4/4 runs");
		expect(note).toContain("ignored shorthand it could see");
		expect(note).toContain("model-adoption result");
		expect(note).not.toContain("IMPOSSIBLE");
		expect(note).not.toContain("HARNESS failure");
	});

	test("a loaded vocabulary the model was never SHOWN is a harness failure, never a model result", () => {
		// The misread this whole field exists to prevent. The first interpretable
		// encode run loaded 551 handles and encoded none, and the report charged
		// that to the model. But the handle table is injected on an asynchronous
		// prompt refresh, and if that refresh does not carry it the model sees the
		// notation, sees no handles, and is told never to invent one. Zero output
		// is then the ONLY compliant behavior, so blaming the model is unsound.
		const note = interpretEncodeArm({
			arm: "full",
			okRuns: 4,
			taught: 4,
			handlesLoaded: 551,
			encoded: 0,
			handlesTaught: 0,
			handlesTaughtKnown: 4,
		});
		expect(note).toContain("reached the model in only 0/4 runs");
		expect(note).toContain("HARNESS failure");
		expect(note).not.toContain("model-adoption result");
		expect(note).not.toContain("ignored");
	});

	test("a partially taught arm is still a harness failure, not a diluted model result", () => {
		// Boundary: some runs taught the table and some did not. The arm is not a
		// clean measurement either way, so it must read as broken rather than be
		// averaged into a model verdict that silently rests on the taught subset.
		const note = interpretEncodeArm({
			arm: "full",
			okRuns: 4,
			taught: 4,
			handlesLoaded: 551,
			encoded: 0,
			handlesTaught: 3,
			handlesTaughtKnown: 4,
		});
		expect(note).toContain("3/4 runs");
		expect(note).toContain("HARNESS failure");
	});

	test("without the taught record the 0-encoded result is declared UNATTRIBUTABLE", () => {
		// A run predating `argot_taught` cannot say whether the table reached the
		// model, so the report must refuse to assign blame instead of defaulting to
		// the model. Defaulting is what produced the original wrong verdict, so the
		// absent-evidence path is pinned separately from the taught and untaught ones.
		const note = interpretEncodeArm({ arm: "full", okRuns: 4, taught: 4, handlesLoaded: 37, encoded: 0 });
		expect(note).toContain("no `argot_taught` record");
		expect(note).toContain("unattributable");
		expect(note).not.toContain("model-adoption result");
		expect(note).not.toContain("HARNESS failure");
	});

	test("actual encoding is declared a real measurement, with the vocabulary size", () => {
		// The only state in which a token delta against the encode arm means what
		// the report says it means. It reports both counts so the reader can judge
		// how much of the arm's mass actually used shorthand.
		const note = interpretEncodeArm({ arm: "full", okRuns: 5, taught: 5, handlesLoaded: 37, encoded: 4 });
		expect(note).toContain("encoded in 4/5 runs");
		expect(note).toContain("37 handles");
		expect(note).toContain("real argot measurement");
	});

	test("an unknown vocabulary size (pre-telemetry run) is declared uninterpretable, not assumed empty", () => {
		// A run recorded before the `argot_armed` telemetry existed has null, which
		// must NOT be silently treated as zero — that would fabricate a confident
		// "the corpus had nothing" verdict from missing data (a silent fallback).
		// The honest answer is that the result cannot be read and the run must be
		// repeated.
		const note = interpretEncodeArm({ arm: "full", okRuns: 4, taught: 4, handlesLoaded: null, encoded: 0 });
		expect(note).toContain("UNKNOWN");
		expect(note).toContain("uninterpretable");
		expect(note).toContain("rerun");
		expect(note).not.toContain("IMPOSSIBLE");
	});

	test("an arm that never taught the preamble gets no interpretation", () => {
		// A decode-only or baseline arm is SUPPOSED to show 0 encoded; emitting a
		// note there would read as a defect report on a correctly-behaving arm and
		// bury the one arm whose interpretation matters.
		expect(interpretEncodeArm({ arm: "decode", okRuns: 5, taught: 0, handlesLoaded: 12, encoded: 0 })).toBeNull();
	});

	test("an all-errored arm gets no interpretation rather than a divide-by-nothing claim", () => {
		// With zero completed runs there is no evidence either way; the arm's own
		// Errors row is the honest signal, not a fabricated adoption verdict.
		expect(interpretEncodeArm({ arm: "full", okRuns: 0, taught: 0, handlesLoaded: null, encoded: 0 })).toBeNull();
	});
});

describe("renderReport — the vocab handles column and its interpretation", () => {
	// End-to-end proof that the instrument reaches the operator-visible report
	// (WIRING): a helper that is never rendered fixes nothing.

	test("an empty-dictionary encode arm renders the handle count AND the corpus-inert warning", () => {
		// Reproduces the exact runs/argot-encode-fixed shape (taught, never
		// encoded) with the missing fact supplied: 0 handles. The report must now
		// state the size in the table and explain the null in prose.
		const md = renderReport(
			[
				res({ arm: "full", task: "t1", reward: 1, argotPreamblePresent: true, argotHandlesLoaded: 0 }),
				res({ arm: "full", task: "t2", reward: 0, argotPreamblePresent: true, argotHandlesLoaded: 0 }),
			],
			"m",
			"now",
		);
		expect(md).toContain("vocab handles");
		expect(md).toContain("| full | 2 | 2/2 | 0 |");
		expect(md).toContain("IMPOSSIBLE");
		expect(md).toContain("NOT a measure of argot");
	});

	test("a loaded, TAUGHT, unused vocabulary renders the size and the model-adoption reading", () => {
		// The other real state: the table shows 37, the handles are proven to have
		// reached the model, and only then does the prose charge the null to the
		// model rather than to the corpus or the harness.
		const md = renderReport(
			[
				res({
					arm: "full",
					task: "t1",
					reward: 1,
					argotPreamblePresent: true,
					argotHandlesLoaded: 37,
					argotHandlesTaught: true,
				}),
				res({
					arm: "full",
					task: "t2",
					reward: 1,
					argotPreamblePresent: true,
					argotHandlesLoaded: 37,
					argotHandlesTaught: true,
				}),
			],
			"m",
			"now",
		);
		expect(md).toContain("| full | 2 | 2/2 | 37 | 2/2 |");
		expect(md).toContain("37 handles were loaded AND taught in 2/2 runs");
		expect(md).toContain("model-adoption result");
	});

	test("a loaded vocabulary the model was never shown renders as a HARNESS failure", () => {
		// The regression that produced the original misreading of runs/argot-smoke-0724.
		// The size column alone looked identical to the model-adoption case above, so
		// the report blamed the model for output it was structurally forbidden to write.
		const md = renderReport(
			[
				res({
					arm: "full",
					task: "t1",
					reward: 1,
					argotPreamblePresent: true,
					argotHandlesLoaded: 551,
					argotHandlesTaught: false,
				}),
			],
			"m",
			"now",
		);
		expect(md).toContain("| full | 1 | 1/1 | 551 | 0/1 |");
		expect(md).toContain("HARNESS failure");
		expect(md).not.toContain("model-adoption result");
	});

	test("a pre-telemetry run renders an em-dash size, never a fabricated zero", () => {
		// Guards the silent-fallback: an older run's missing record must render as
		// unknown, not as the load-produced-nothing verdict.
		const md = renderReport(
			[res({ arm: "full", task: "t1", reward: 1, argotPreamblePresent: true, argotHandlesLoaded: null })],
			"m",
			"now",
		);
		expect(md).toContain("| full | 1 | 1/1 | — |");
		expect(md).toContain("uninterpretable");
		expect(md).not.toContain("IMPOSSIBLE");
	});

	test("the handle count survives a stray row that lacks the record", () => {
		// A per-repo property is constant across a task's repeats, so one row
		// missing the record (a crashed early session) must not blank the column
		// for the whole arm and destroy the interpretation.
		const md = renderReport(
			[
				res({ arm: "full", task: "t1", reward: 1, argotPreamblePresent: true, argotHandlesLoaded: null }),
				res({ arm: "full", task: "t2", reward: 1, argotPreamblePresent: true, argotHandlesLoaded: 12 }),
			],
			"m",
			"now",
		);
		expect(md).toContain("| full | 2 | 2/2 | 12 |");
		expect(md).toContain("12 handles were loaded");
	});
});

describe("encodeHeadroom — the effect-size ceiling that decides if a run can measure argot at all", () => {
	// The finding this encodes: on the real ytt task the loaded dictionary offered
	// a maximum saving of 0.27% of emitted output while run-to-run token variance
	// was ~9%. Every argot delta that run produced was noise, and no repeat count
	// could have fixed it, because the limit was the WORKLOAD, not the sample size.
	// Nothing in the bench could say so. These lock the arithmetic and the verdict.

	test("counts only handles the model actually emitted, and prices each at expansion minus handle", () => {
		// The core sum. `§pkg` (4 chars with the sigil) standing for a 24-char path
		// emitted twice saves 2*(24-4)=40; a handle never emitted saves nothing and
		// must not inflate the ceiling just by existing in the dictionary.
		const emitted = "edit packages/server/db.ts then packages/server/db.ts again";
		const h = encodeHeadroom(emitted, { pkg: "packages/server/db.ts", unused: "never/typed/path.ts" });
		expect(h.handles).toBe(2);
		expect(h.usableHandles).toBe(1);
		// "packages/server/db.ts" is 21 chars; "§pkg" is 4; twice => 2*17 = 34.
		expect(h.maxSavedChars).toBe(34);
		expect(h.emittedChars).toBe(emitted.length);
		expect(h.maxSavedPct).toBeCloseTo((100 * 34) / emitted.length, 6);
	});

	test("a vocabulary of long strings the model never writes yields a zero ceiling", () => {
		// Exactly the real failure: the dictionary was dominated by license text and
		// example-fixture YAML, which repeat heavily in the repo but which a coding
		// agent never types. Handle count looks healthy, achievable saving is zero.
		const h = encodeHeadroom("fix the bug in pkg/orderedmap/map.go", {
			lic: "use, copy, modify, merge, publish, distribute, sublicense",
			fixture: "app.kubernetes.io/component: controller",
		});
		expect(h.handles).toBe(2);
		expect(h.usableHandles).toBe(0);
		expect(h.maxSavedChars).toBe(0);
		expect(h.maxSavedPct).toBe(0);
	});

	test("occurrences are counted non-overlapping, the way a real encoder substitutes", () => {
		// A self-overlapping expansion must not be double-counted into a ceiling the
		// encoder could never actually realize.
		const h = encodeHeadroom("aaaa", { a: "aa" });
		expect(h.maxSavedChars).toBe(0); // "aa" (2) vs "§a" (2): no saving per occurrence
		expect(h.usableHandles).toBe(1);
	});

	test("an expansion no longer than its handle contributes nothing, never a negative saving", () => {
		// An encoder would simply decline such a handle; letting it subtract would
		// let a junk vocabulary hide real headroom from other handles.
		const h = encodeHeadroom("id id id", { averylongname: "id" });
		expect(h.maxSavedChars).toBe(0);
	});

	test("an empty emission reports a zero percentage rather than dividing by zero", () => {
		const h = encodeHeadroom("", { pkg: "packages/server/db.ts" });
		expect(h.maxSavedPct).toBe(0);
		expect(h.emittedChars).toBe(0);
		expect(Number.isNaN(h.maxSavedPct)).toBe(false);
	});
});

describe("relativeSpreadPct / ceilingBelowNoise — is the ceiling big enough to see", () => {
	test("spread is measured relative to the mean so it compares against a percentage ceiling", () => {
		// Identical samples have no spread: a run whose repeats agree exactly can
		// resolve arbitrarily small effects, so the floor must fall to zero.
		expect(relativeSpreadPct([100, 100, 100])).toBe(0);
		const spread = relativeSpreadPct([90, 110]);
		expect(spread).toBeCloseTo((100 * Math.sqrt(200)) / 100, 6);
	});

	test("fewer than two samples has no observable spread and must not fabricate one", () => {
		// With one sample the run cannot estimate its own noise; claiming 0 would
		// declare every tiny ceiling measurable, which is the error this prevents.
		expect(relativeSpreadPct([100])).toBeNull();
		expect(relativeSpreadPct([])).toBeNull();
	});

	test("the real ytt numbers are correctly judged unmeasurable", () => {
		// 0.27% achievable against ~9% observed noise: the exact case that motivated
		// this instrument. It must come back as cannot-measure.
		expect(ceilingBelowNoise(0.27, 9)).toBe(true);
	});

	test("a ceiling above the noise is measurable", () => {
		expect(ceilingBelowNoise(15, 9)).toBe(false);
	});

	test("with no noise estimate a conservative one-percent floor applies", () => {
		// A single-sample run still must not bless a 0.3% ceiling as detectable.
		expect(ceilingBelowNoise(0.3, null)).toBe(true);
		expect(ceilingBelowNoise(4, null)).toBe(false);
	});
});

describe("collectEmittedText — the denominator must match where handles are counted", () => {
	test("collects assistant text AND tool-call arguments, the same seams the sigil probe scans", () => {
		// If the two disagreed, the ceiling could claim a saving in a place the
		// encode probe never inspects, and the report's two argot numbers would
		// silently describe different runs.
		const text = collectEmittedText([
			{
				role: "assistant",
				content: [{ text: "editing the file" }, { type: "toolCall", arguments: { path: "a/b.ts" } }],
			},
		]);
		expect(text).toContain("editing the file");
		expect(text).toContain("a/b.ts");
	});

	test("excludes tool results, which the model receives rather than emits", () => {
		// Tool output is harness-produced context, not output the model pays for.
		// Counting it would inflate the denominator and understate the ceiling.
		const text = collectEmittedText([
			{ role: "assistant", content: [{ text: "run it" }] },
			{ role: "toolResult", content: [{ text: "MASSIVE COMPILER OUTPUT" }] },
			{ role: "user", content: [{ text: "user text" }] },
		]);
		expect(text).toContain("run it");
		expect(text).not.toContain("MASSIVE COMPILER OUTPUT");
		expect(text).not.toContain("user text");
	});
});

describe("renderReport — the encode headroom section", () => {
	test("a below-noise ceiling is called out as CANNOT MEASURE, not as a null result", () => {
		// The whole point: without this the same run reads "not distinguishable",
		// which invites "we measured argot and it does not help" when the truth is
		// "this workload cannot show it either way".
		const md = renderReport(
			[
				res({
					arm: "full",
					task: "t1",
					repeat: 0,
					reward: 1,
					outputTokens: 70000,
					encodeHeadroom: {
						emittedChars: 100000,
						handles: 33,
						usableHandles: 7,
						maxSavedChars: 270,
						maxSavedPct: 0.27,
					},
				}),
				res({
					arm: "full",
					task: "t1",
					repeat: 1,
					reward: 1,
					outputTokens: 84000,
					encodeHeadroom: {
						emittedChars: 100000,
						handles: 33,
						usableHandles: 7,
						maxSavedChars: 270,
						maxSavedPct: 0.27,
					},
				}),
			],
			"m",
			"now",
			2,
		);
		expect(md).toContain("Encode headroom");
		expect(md).toContain("CANNOT MEASURE");
		expect(md).toContain("| full | 200000 | 33 | 7 | 540 | 0.27% |");
	});

	test("a ceiling above the noise is reported as measurable", () => {
		// The instrument must not cry wolf on a workload that CAN show the effect,
		// or operators will learn to ignore it.
		const md = renderReport(
			[
				res({
					arm: "full",
					task: "t1",
					repeat: 0,
					reward: 1,
					outputTokens: 70000,
					encodeHeadroom: {
						emittedChars: 1000,
						handles: 10,
						usableHandles: 9,
						maxSavedChars: 200,
						maxSavedPct: 20,
					},
				}),
				res({
					arm: "full",
					task: "t1",
					repeat: 1,
					reward: 1,
					outputTokens: 70100,
					encodeHeadroom: {
						emittedChars: 1000,
						handles: 10,
						usableHandles: 9,
						maxSavedChars: 200,
						maxSavedPct: 20,
					},
				}),
			],
			"m",
			"now",
			2,
		);
		expect(md).toContain("measurable — the ceiling exceeds");
		expect(md).not.toContain("CANNOT MEASURE");
	});

	test("the section is absent entirely when no run recorded a vocabulary", () => {
		// An older run has nothing to bound, and inventing a ceiling of zero would
		// wrongly declare every such run unmeasurable.
		const md = renderReport([res({ arm: "baseline", task: "t1", reward: 1 })], "m", "now");
		expect(md).not.toContain("Encode headroom");
	});
});

describe("typeableHandleMass — the pre-run screen for whether a repo can measure shorthand at all", () => {
	// Calibration, not assumption: on the first run where encoding fired, all 7
	// handles the model emitted were whitespace-free and NO whitespace-bearing
	// handle was ever emitted (100% recall, 33% precision). That makes a low score
	// a sound one-sided verdict — such a repo cannot show the effect — which is
	// what lets this screen tasks before a multi-hour run instead of after.

	test("prose handles are excluded however much repository mass they carry", () => {
		// The exact shape that produced a 0.27% ceiling: license text and fixture
		// YAML dominate the dictionary by repetition but no agent ever types them.
		// Counting them would rank an unmeasurable repo as a great candidate.
		const m = typeableHandleMass({
			lic: "use, copy, modify, merge, publish, distribute, sublicense",
			fixture: "app.kubernetes.io/component: controller",
			pkg: "carvel.dev/ytt/pkg/orderedmap",
		});
		expect(m.handles).toBe(3);
		expect(m.typeable).toBe(1);
		// "carvel.dev/ytt/pkg/orderedmap" is 29 chars, "§pkg" is 4 => 25.
		expect(m.savingPerEmission).toBe(25);
		expect(m.longestTypeable).toBe(29);
	});

	test("a handle that saves nothing is not counted as reachable mass", () => {
		// An expansion no longer than its handle would never be substituted, so
		// including it would inflate the screen with substitutions that cannot help.
		const m = typeableHandleMass({ averylongname: "short" });
		expect(m.typeable).toBe(0);
		expect(m.savingPerEmission).toBe(0);
	});

	test("an all-prose vocabulary scores zero, the sound 'cannot measure' verdict", () => {
		// The one-sided conclusion this screen is for: whatever the run does, a repo
		// offering nothing an agent types cannot demonstrate a shorthand effect.
		const m = typeableHandleMass({
			a: "the quick brown fox jumps",
			b: "Licensed under the Apache License, Version 2.0",
		});
		expect(m.typeable).toBe(0);
		expect(m.savingPerEmission).toBe(0);
		expect(m.longestTypeable).toBe(0);
	});

	test("import paths and file paths are counted, which is what agents retype", () => {
		// The positive case, taken from the handles the model actually did emit.
		const m = typeableHandleMass({
			star: "github.com/k14s/starlark-go/starlark",
			files: "carvel.dev/ytt/pkg/files",
			src: "packages/coding-agent/src/database/connection.ts",
		});
		expect(m.typeable).toBe(3);
		expect(m.longestTypeable).toBe("packages/coding-agent/src/database/connection.ts".length);
	});

	test("an empty vocabulary is scored without dividing or throwing", () => {
		const m = typeableHandleMass({});
		expect(m).toEqual({
			handles: 0,
			typeable: 0,
			savingPerEmission: 0,
			expectedSavingPerEmission: 0,
			longestTypeable: 0,
		});
	});

	/**
	 * `savingPerEmission` is an UPPER bound and was read as a forecast, which is
	 * how the 16000-token arm came to be built on a 19.07% projected ceiling
	 * against a measured 0.24%. The expected column scales it by the rate a run
	 * actually emits at, so the two numbers are on the same scale.
	 */
	test("expected saving is the typeable bound scaled by the observed emission rate", () => {
		const m = typeableHandleMass({
			files: "carvel.dev/ytt/pkg/files",
			src: "packages/coding-agent/src/database/connection.ts",
		});

		expect(m.expectedSavingPerEmission).toBe(Math.round(m.savingPerEmission * OBSERVED_TYPEABLE_EMISSION_RATE));
		expect(m.expectedSavingPerEmission).toBeLessThan(m.savingPerEmission);
	});

	/**
	 * The rate is the whole correction, so its value is pinned rather than left to
	 * drift: it is 8 of 551 handles emitted on `runs/argot-smoke-0724`, the only
	 * run that has both loaded a dictionary and emitted from it. A later run may
	 * revise it, and this test is what makes that a deliberate act.
	 */
	test("the emission rate is the one measured 8/551, not a rounded guess", () => {
		expect(OBSERVED_TYPEABLE_EMISSION_RATE).toBe(8 / 551);
		expect(OBSERVED_TYPEABLE_EMISSION_RATE).toBeCloseTo(0.0145, 4);
	});

	/**
	 * The reason to trust the correction rather than merely prefer it: applied to
	 * the projection that failed by fifty times, it reproduces the measurement. A
	 * 19.07% projected ceiling scaled by the rate is 0.277%, against a measured
	 * 0.24%. Locked here because that agreement is the entire argument, and a
	 * silent change to the rate would dissolve it without failing anything else.
	 */
	test("the corrected projection reproduces the ceiling the original missed by 50x", () => {
		const correctedCeilingPct = 19.07 * OBSERVED_TYPEABLE_EMISSION_RATE;

		expect(correctedCeilingPct).toBeCloseTo(0.277, 2);
		// Within 20% of the 0.24% the run measured, against 79x for the original.
		expect(Math.abs(correctedCeilingPct - 0.24) / 0.24).toBeLessThan(0.2);
		expect(19.07 / 0.24).toBeGreaterThan(50);
	});

	/**
	 * The consequence that changes what anyone should do next: the corrected
	 * ceiling scales with the dictionary budget while the noise floor does not, so
	 * no budget reaches it. A 16x budget buys a quarter of a percentage point
	 * against a floor of 8.15%. Raising `tokenBudget` is not the lever, and this
	 * is the assertion that says so in a form that cannot be forgotten.
	 */
	test("no dictionary budget brings the expected ceiling near the noise floor", () => {
		const NOISE_FLOOR_PCT = 8.15;
		const projectedByBudget = { 1000: 1.01, 4000: 2.56, 16000: 19.07 };

		for (const projected of Object.values(projectedByBudget)) {
			expect(projected * OBSERVED_TYPEABLE_EMISSION_RATE).toBeLessThan(NOISE_FLOOR_PCT / 10);
		}
		// Even a further 16x on the largest budget, extrapolated linearly, misses.
		expect(19.07 * 16 * OBSERVED_TYPEABLE_EMISSION_RATE).toBeLessThan(NOISE_FLOOR_PCT);
	});
});

describe("withinTaskSpreadPct — the noise floor must measure chance, not task difficulty", () => {
	// The bug this fixes: the headroom verdict originally pooled every sample of an
	// arm across tasks to estimate noise. Output size is driven far more by which
	// task is being solved than by run-to-run variance, so the pooled figure was a
	// measure of corpus difficulty. That inflated floor would stamp CANNOT MEASURE
	// on a run whose ceiling comfortably cleared real noise, silently discarding a
	// valid result — the opposite of the error the instrument exists to prevent.

	test("wildly different tasks with perfectly stable repeats report ZERO noise", () => {
		// The exact failure mode. Task A emits 1,000 tokens and task B emits 100,000,
		// but each repeats identically, so there is no run-to-run variance at all.
		// Pooling would report a spread near 140%; the correct answer is 0.
		const rows: ArmResult[] = [
			res({ arm: "a", task: "small", repeat: 0, outputTokens: 1000 }),
			res({ arm: "a", task: "small", repeat: 1, outputTokens: 1000 }),
			res({ arm: "a", task: "huge", repeat: 0, outputTokens: 100000 }),
			res({ arm: "a", task: "huge", repeat: 1, outputTokens: 100000 }),
		];
		expect(withinTaskSpreadPct(rows)).toBe(0);
		// And the pooled calculation really would have been enormous, which is why
		// this test asserts the contrast rather than the fixed value alone.
		expect(relativeSpreadPct([1000, 1000, 100000, 100000])!).toBeGreaterThan(100);
	});

	test("real within-task variation is reported", () => {
		// Two tasks each varying by the same relative amount: the floor is that
		// amount, not something diluted or amplified by their different sizes.
		const rows: ArmResult[] = [
			res({ arm: "a", task: "x", repeat: 0, outputTokens: 90 }),
			res({ arm: "a", task: "x", repeat: 1, outputTokens: 110 }),
			res({ arm: "a", task: "y", repeat: 0, outputTokens: 900 }),
			res({ arm: "a", task: "y", repeat: 1, outputTokens: 1100 }),
		];
		const expected = relativeSpreadPct([90, 110])!;
		expect(withinTaskSpreadPct(rows)).toBeCloseTo(expected, 6);
	});

	test("the median across tasks keeps one pathological task from setting the floor", () => {
		// A single erratic task (a retried timeout) must not raise the noise floor for
		// the whole run and suppress an otherwise valid verdict.
		const rows: ArmResult[] = [
			res({ arm: "a", task: "x", repeat: 0, outputTokens: 100 }),
			res({ arm: "a", task: "x", repeat: 1, outputTokens: 100 }),
			res({ arm: "a", task: "y", repeat: 0, outputTokens: 100 }),
			res({ arm: "a", task: "y", repeat: 1, outputTokens: 100 }),
			res({ arm: "a", task: "wild", repeat: 0, outputTokens: 10 }),
			res({ arm: "a", task: "wild", repeat: 1, outputTokens: 10000 }),
		];
		expect(withinTaskSpreadPct(rows)).toBe(0);
	});

	test("errored samples are excluded from the floor", () => {
		// An errored run has no trustworthy token count; letting it in would invent
		// variance that never happened.
		const rows: ArmResult[] = [
			res({ arm: "a", task: "x", repeat: 0, outputTokens: 100 }),
			res({ arm: "a", task: "x", repeat: 1, outputTokens: 100 }),
			res({ arm: "a", task: "x", repeat: 2, outputTokens: 99999, error: "CancelledError" }),
		];
		expect(withinTaskSpreadPct(rows)).toBe(0);
	});

	test("a single-repeat run has no observable spread", () => {
		// With one sample per task nothing can be said about chance, and the caller
		// falls back to its conservative floor rather than assuming zero noise.
		const rows: ArmResult[] = [
			res({ arm: "a", task: "x", repeat: 0, outputTokens: 100 }),
			res({ arm: "a", task: "y", repeat: 0, outputTokens: 5000 }),
		];
		expect(withinTaskSpreadPct(rows)).toBeNull();
	});

	test("the headroom verdict uses the within-task floor, not the pooled one", () => {
		// End-to-end proof on the shape that used to break: two tasks of very
		// different sizes, stable repeats, and a 5% ceiling. Pooled noise would be
		// ~140% and read CANNOT MEASURE; the true floor is 0%, so this is measurable.
		const hr = { emittedChars: 1000, handles: 10, usableHandles: 8, maxSavedChars: 50, maxSavedPct: 5 };
		const rows: ArmResult[] = [
			res({ arm: "full", task: "small", repeat: 0, reward: 1, outputTokens: 1000, encodeHeadroom: hr }),
			res({ arm: "full", task: "small", repeat: 1, reward: 1, outputTokens: 1000, encodeHeadroom: hr }),
			res({ arm: "full", task: "huge", repeat: 0, reward: 1, outputTokens: 100000, encodeHeadroom: hr }),
			res({ arm: "full", task: "huge", repeat: 1, reward: 1, outputTokens: 100000, encodeHeadroom: hr }),
		];
		const md = renderReport(rows, "m", "now", 2);
		expect(md).toContain("measurable — the ceiling exceeds");
		expect(md).not.toContain("CANNOT MEASURE");
	});
});
