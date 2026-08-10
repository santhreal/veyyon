/**
 * What the session is allowed to do to history the operator already saw.
 *
 * WHY THIS FILE EXISTS. At the end of every turn the session rewrites its own
 * stored history: a `read` result that a newer read of the same file has made
 * stale is blanked to a placeholder, and a result its tool flagged contextually
 * useless is elided. The rewrite is persisted and then pushed back into the
 * agent with `replaceMessages`, so it lands in two places at once, and both of
 * them are load-bearing: the stored branch is what a fork or a resume rebuilds
 * from, and the agent's copy is what the NEXT request puts on the wire. The pure
 * pruning functions have unit coverage; the sequence that reaches them from a
 * live turn, in the real order, with the real settings, did not.
 *
 * The rewrite is also the one maintenance pass that runs with compaction
 * disabled (it sits before the threshold gate in `checkCompaction`), which is
 * exactly the configuration most simulations use, so an operator can hit it
 * without ever crossing a context threshold.
 *
 * ASSERTED, per row, in BOTH states of the two settings that gate it: which
 * results were blanked and which were left alone, that the blanked text is the
 * exact notice, that the store and the outbound context agree afterwards, that
 * no result was REMOVED by a rewrite (a blanked result is still an answer to its
 * call), and that the request following the rewrite is still well paired.
 *
 * NOT asserted: which of the two independent protections keeps a `skill://`
 * read intact. The supersede key exempts URL-scheme paths and the protected-tool
 * matcher exempts skill reads, so that row proves the outcome and cannot
 * attribute it. Age-based pruning (`pruneToolOutputs`) is also out of scope: its
 * 20 000-token savings floor is unreachable at simulation size, so a cell
 * claiming to exercise it would be a fixture that never reaches the branch.
 *
 * MEASURED REDUNDANCY, which is what these cells can and cannot see. Single-site
 * mutations were run against the suite and several changed nothing, because the
 * product protects these outcomes more than once:
 *   - Deleting the `agent.replaceMessages` refresh after the stale pass leaves
 *     every cell green: the pass blanks the result message IN PLACE and the
 *     agent holds the same object, so the live view is already correct. The
 *     store-and-wire cells red only when that in-place write is ALSO replaced by
 *     a fresh entry object (4 cells red), which is the real hazard: a rewrite
 *     that reaches the persisted branch and not the live context.
 *   - The `a failing result that also claims to be useless` row reds only when
 *     all THREE error guards are removed (`coerceToolResult`, the result-message
 *     builder in `executeToolCalls`, and `collectUselessResults`). Removing any
 *     one or two leaves it green. The row pins the OUTCOME an operator depends
 *     on and does not claim to pin any single guard.
 *   - Supersede has no such redundancy: the key function is the pass's only
 *     owner, and making `readToolSupersedeKey` return `undefined` reds the three
 *     rows that expect a blanked read while leaving every off-state cell green.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage, AgentTool } from "@veyyon/agent-core";
import { SUPERSEDED_NOTICE, USELESS_NOTICE } from "@veyyon/agent-core/compaction/pruning";
import type { Context } from "@veyyon/ai";
import { createSimulation, type Simulation, scriptTurns, simTool } from "./harness";
import { describeViolations, pairingViolations, toolResultsIn, turnViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** Long enough that blanking it saves tokens, short enough to stay readable. */
function bodyFor(label: string): string {
	return `contents of ${label}: ${"lorem ipsum ".repeat(20)}`;
}

interface Call {
	readonly tool: string;
	readonly args: Record<string, unknown>;
	readonly id: string;
}

/** What the maintenance pass is expected to have done to one recorded result. */
type Outcome = "intact" | "superseded" | "useless";

interface Row {
	readonly name: string;
	/** Calls the first prompt makes. */
	readonly first: readonly Call[];
	/** Calls the second prompt makes; the pass runs after each prompt. */
	readonly second: readonly Call[];
	/** Outcome per tool-call id once both settings are on. */
	readonly whenOn: Readonly<Record<string, Outcome>>;
}

const ROWS: readonly Row[] = [
	{
		name: "the same path read twice",
		first: [{ tool: "read", args: { path: "src/a.ts" }, id: "read-1" }],
		second: [{ tool: "read", args: { path: "src/a.ts" }, id: "read-2" }],
		whenOn: { "read-1": "superseded", "read-2": "intact" },
	},
	{
		name: "two different paths",
		first: [{ tool: "read", args: { path: "src/a.ts" }, id: "read-1" }],
		second: [{ tool: "read", args: { path: "src/b.ts" }, id: "read-2" }],
		whenOn: { "read-1": "intact", "read-2": "intact" },
	},
	{
		name: "a whole-file read after a range read of the same file",
		first: [{ tool: "read", args: { path: "src/a.ts:10-40" }, id: "read-1" }],
		second: [{ tool: "read", args: { path: "src/a.ts" }, id: "read-2" }],
		whenOn: { "read-1": "superseded", "read-2": "intact" },
	},
	{
		// The prefix rule runs one way only: a bare read supersedes a range read
		// of the same file, and a range read does NOT supersede the whole file it
		// was cut from, because the range answers less than the earlier result did.
		name: "a range read after a whole-file read of the same file",
		first: [{ tool: "read", args: { path: "src/a.ts" }, id: "read-1" }],
		second: [{ tool: "read", args: { path: "src/a.ts:10-40" }, id: "read-2" }],
		whenOn: { "read-1": "intact", "read-2": "intact" },
	},
	{
		name: "the same range read twice",
		first: [{ tool: "read", args: { path: "src/a.ts:10-40" }, id: "read-1" }],
		second: [{ tool: "read", args: { path: "src/a.ts:10-40" }, id: "read-2" }],
		whenOn: { "read-1": "superseded", "read-2": "intact" },
	},
	{
		name: "a skill read twice",
		first: [{ tool: "read", args: { path: "skill://record-demo/SKILL.md" }, id: "read-1" }],
		second: [{ tool: "read", args: { path: "skill://record-demo/SKILL.md" }, id: "read-2" }],
		whenOn: { "read-1": "intact", "read-2": "intact" },
	},
	{
		name: "a result its tool flagged useless",
		first: [{ tool: "empty-search", args: { pattern: "nothing" }, id: "search-1" }],
		second: [{ tool: "read", args: { path: "src/a.ts" }, id: "read-2" }],
		whenOn: { "search-1": "useless", "read-2": "intact" },
	},
	{
		// A failure the operator can no longer read is a failure they cannot fix,
		// so `isError` outranks the useless flag: the loop drops the flag rather
		// than letting the pass elide the diagnosis.
		name: "a failing result that also claims to be useless",
		first: [{ tool: "failing-search", args: { pattern: "nothing" }, id: "search-1" }],
		second: [{ tool: "read", args: { path: "src/a.ts" }, id: "read-2" }],
		whenOn: { "search-1": "intact", "read-2": "intact" },
	},
];

/** Both gates on (the shipped default) and both off. */
const GATES = [
	{ label: "maintenance on", settings: { "compaction.supersedeReads": true, "compaction.dropUseless": true } },
	{ label: "maintenance off", settings: { "compaction.supersedeReads": false, "compaction.dropUseless": false } },
] as const;

function maintenanceTools(): AgentTool[] {
	return [
		simTool("read", async (_id, args) => ({
			content: [{ type: "text", text: bodyFor(String(args.path)) }],
		})),
		simTool("empty-search", async (_id, args) => ({
			content: [{ type: "text", text: bodyFor(`no matches for ${String(args.pattern)}`) }],
			useless: true,
		})),
		simTool("failing-search", async (_id, args) => ({
			content: [{ type: "text", text: bodyFor(`search backend refused ${String(args.pattern)}`) }],
			isError: true,
			useless: true,
		})),
	];
}

/** Every tool-result text in order, for the wire where ids have been renamed. */
function textsOfResults(messages: readonly AgentMessage[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		texts.push(
			message.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join(""),
		);
	}
	return texts;
}

function textOfResult(messages: readonly AgentMessage[], toolCallId: string): string {
	for (const message of messages) {
		if (message.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
		return message.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
	}
	return "(no result recorded)";
}

function expectedTextFor(row: Row, call: Call, gated: boolean): string {
	const outcome = gated ? row.whenOn[call.id] : "intact";
	if (outcome === "superseded") return SUPERSEDED_NOTICE;
	if (outcome === "useless") return USELESS_NOTICE;
	if (call.tool === "read") return bodyFor(String(call.args.path));
	if (call.tool === "empty-search") return bodyFor(`no matches for ${String(call.args.pattern)}`);
	return bodyFor(`search backend refused ${String(call.args.pattern)}`);
}

describe("the end-of-turn maintenance pass rewrites history in both places or neither", () => {
	it("covers reads that collide, reads that do not, a protected read, and both flag outcomes", () => {
		expect(ROWS.length).toBeGreaterThanOrEqual(8);
		expect(ROWS.some(row => Object.values(row.whenOn).includes("superseded"))).toBe(true);
		expect(ROWS.some(row => Object.values(row.whenOn).includes("useless"))).toBe(true);
		expect(ROWS.some(row => Object.values(row.whenOn).every(outcome => outcome === "intact"))).toBe(true);
		expect(GATES.length).toBe(2);
	});

	for (const row of ROWS) {
		for (const gate of GATES) {
			it(`${row.name}, ${gate.label}`, async () => {
				const cell = `${row.name} / ${gate.label}`;
				const contexts: Context[] = [];
				sim = await createSimulation({
					settings: { "retry.enabled": false, ...gate.settings },
					tools: maintenanceTools(),
					script: scriptTurns(
						turn => {
							contexts.push(turn.context);
							for (const call of row.first) turn.toolCall(call.tool, call.args, call.id);
							turn.finish("toolUse");
						},
						turn => {
							contexts.push(turn.context);
							turn.text("first prompt done");
							turn.finish();
						},
						turn => {
							contexts.push(turn.context);
							for (const call of row.second) turn.toolCall(call.tool, call.args, call.id);
							turn.finish("toolUse");
						},
						turn => {
							contexts.push(turn.context);
							turn.text("second prompt done");
							turn.finish();
						},
						turn => {
							contexts.push(turn.context);
							turn.text("third prompt done");
							turn.finish();
						},
					),
				});

				await sim.session.prompt("read the first thing");
				await sim.session.prompt("read the second thing");
				// The third prompt exists to carry whatever the pass did onto the
				// wire: its request is shaped from the agent's copy of history,
				// which the rewrite replaced.
				await sim.session.prompt("now answer");

				expect(describeViolations(cell, turnViolations(sim))).toEqual([]);
				const calls = [...row.first, ...row.second];
				// A rewrite blanks a result; it never drops one. Losing a result
				// leaves the call it answered unpaired on every later request.
				expect(
					toolResultsIn(sim.session.messages)
						.map(result => result.id)
						.sort(),
				).toEqual(calls.map(call => call.id).sort());

				const outbound = contexts.at(-1);
				expect(outbound).toBeDefined();
				expect(describeViolations(cell, pairingViolations(outbound?.messages ?? []))).toEqual([]);

				for (const call of calls) {
					const expected = expectedTextFor(row, call, gate.label === "maintenance on");
					expect(`${call.id} stored: ${textOfResult(sim.session.messages, call.id)}`).toBe(
						`${call.id} stored: ${expected}`,
					);
				}
				// The store and the wire must say the same thing. A rewrite that
				// persisted but never reached the agent (or the reverse) sends a
				// context that no longer matches the session it came from, which is
				// how a resume diverges from a live run.
				//
				// The wire is matched POSITIONALLY: `canonicalizeToolCallIds`
				// renames every outbound id to a session-local `tc_<n>` handle in
				// first-sight order, so the stored id is not a key there. Order is
				// the contract that survives the rename, and `pairingViolations`
				// above is what proves the renamed calls and results still agree.
				const expectedTexts = calls.map(call => expectedTextFor(row, call, gate.label === "maintenance on"));
				expect(textsOfResults(outbound?.messages ?? [])).toEqual(expectedTexts);
			});
		}
	}
});
