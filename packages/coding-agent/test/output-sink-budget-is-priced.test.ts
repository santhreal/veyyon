import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext } from "@veyyon/agent-core";
import type { Settings } from "@veyyon/coding-agent/config/settings";
import type { BashExecutorOptions } from "@veyyon/coding-agent/exec/bash-executor";
import type { SSHExecutorOptions } from "@veyyon/coding-agent/ssh/ssh-executor";
import type { runInteractiveBashPty } from "@veyyon/coding-agent/tools/bash-interactive";
import { type InlinePricingSource, inlineBudgetFor } from "@veyyon/coding-agent/tools/output-artifact";
import { wrapToolWithMetaNotice } from "@veyyon/coding-agent/tools/output-meta";
import { type } from "arktype";

/**
 * Structural lock: every streaming executor prices its inline output budget.
 *
 * WHY THIS SUITE EXISTS, and why it reads source rather than behaviour. There
 * were two owners of the question "how many bytes of tool output may stay
 * inline", and they disagreed by a factor of four.
 *
 * `resolveInlineCap` and `tools.inlineOutputFloor` price the budget by how long
 * the result will sit in context, and reach a tool through
 * `enforceInlineByteCap`. But the centralised artifact spill explicitly skips
 * any tool that saved its own artifact, and every streaming executor does, so
 * none of them ever reached the priced path. They took `OutputSink`'s flat 50KB
 * default instead.
 *
 * That was not a rounding error. Measured over nine live sessions, `eval` alone
 * produced 80.9% of all tool-result bytes, its largest tenth of results carried
 * two thirds of its total, and its largest single result was 71,769 characters,
 * which then cost a full re-read on every remaining turn of the session. The
 * priced setting existed the whole time and governed 4% of the bytes.
 *
 * A behavioural test cannot catch the regression, because the failure mode is a
 * NEW call site that forgets the argument: nothing breaks, output is merely
 * unpriced again and the loss is invisible. So this asserts the contract at the
 * only place it is visible, the construction sites themselves. If you add an
 * `OutputSink`, give it a priced `spillThreshold` and add the file here.
 */

const ROOT = path.join(import.meta.dir, "..", "src");

/** Every source file that constructs an `OutputSink`, found rather than assumed. */
function sinkConstructionSites(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts")) continue;
			if (fs.readFileSync(full, "utf8").includes("new OutputSink(")) found.push(full);
		}
	};
	walk(ROOT);
	return found.sort();
}

describe("OutputSink inline budget", () => {
	/**
	 * The discovery step itself is asserted, because a scan that silently finds
	 * nothing would make every check below pass vacuously. Six sites were known
	 * when this was written; a seventh is fine and must satisfy the same rule,
	 * but zero means the scan broke.
	 */
	it("finds the streaming executors that construct a sink", () => {
		const sites = sinkConstructionSites().map(file => path.relative(ROOT, file));
		expect(sites.length).toBeGreaterThanOrEqual(6);
		expect(sites).toContain(path.join("tools", "eval.ts"));
		expect(sites).toContain(path.join("eval", "executor-base.ts"));
		expect(sites).toContain(path.join("eval", "js", "executor.ts"));
		expect(sites).toContain(path.join("exec", "bash-executor.ts"));
		expect(sites).toContain(path.join("ssh", "ssh-executor.ts"));
		expect(sites).toContain(path.join("tools", "bash-interactive.ts"));
	});

	/**
	 * The contract. A sink either prices its own budget from a session
	 * (`inlineBudgetFor`) or forwards one its caller priced (`options.spillThreshold`).
	 * What it may not do is omit the field and inherit the flat default, which is
	 * exactly what all six did.
	 */
	it("gives every sink a priced spillThreshold, never the flat default", () => {
		const unpriced: string[] = [];
		for (const file of sinkConstructionSites()) {
			const source = fs.readFileSync(file, "utf8");
			const pricesItself = source.includes("spillThreshold: inlineBudgetFor(");
			const forwardsCallerBudget = /spillThreshold: options[.?]*\.spillThreshold/.test(source);
			if (!pricesItself && !forwardsCallerBudget) unpriced.push(path.relative(ROOT, file));
		}
		expect(unpriced).toEqual([]);
	});

	/**
	 * The specific regression, named so the failure message says what broke.
	 * `eval/js/executor.ts` used to pass `spillThreshold: DEFAULT_MAX_BYTES`,
	 * which looks deliberate and is the flat default spelled out longhand. That
	 * is worse than omitting it, because it reads as a considered choice.
	 */
	it("never hardcodes the flat DEFAULT_MAX_BYTES as a sink budget", () => {
		const offenders = sinkConstructionSites().filter(file =>
			fs.readFileSync(file, "utf8").includes("spillThreshold: DEFAULT_MAX_BYTES"),
		);
		expect(offenders.map(file => path.relative(ROOT, file))).toEqual([]);
	});

	/**
	 * An executor with no session cannot price anything, so it must take the number as an option
	 * instead of inventing one. Asserted as a TYPE rather than as the text `spillThreshold?: number;`,
	 * which a doc comment quoting the field satisfies just as well and which a reformat breaks. The
	 * compiler is what actually refuses a caller that tries to pass the budget to an executor that
	 * does not accept one, so the compiler is what checks it: `bunx tsgo` fails on this block if any
	 * of the three drops the field or retypes it.
	 */
	it("lets a session-less executor receive a budget from its caller", () => {
		const bash: BashExecutorOptions = { spillThreshold: 1_024 };
		const ssh: SSHExecutorOptions = { spillThreshold: 2_048 };
		const pty: InteractivePtyOptions = { command: "true", cwd: "/tmp", spillThreshold: 4_096 };

		// And the runtime half, so this is not only a compile-time shape: the values survive as
		// numbers, which is what an executor forwards into its sink.
		expect([bash.spillThreshold, ssh.spillThreshold, pty.spillThreshold]).toEqual([1_024, 2_048, 4_096]);
	});
});

/** The interactive PTY runner takes its options inline, so there is no named type to reference. */
type InteractivePtyOptions = Parameters<typeof runInteractiveBashPty>[1];

/**
 * Run a non-streaming tool that returns `payload` through the real registry wrapper at `turnIndex`.
 *
 * Reports whether the spill fired rather than how many characters came back: a spilled result gains
 * an `artifact://` recovery notice, so it can be LONGER than the payload it replaced, and length is
 * not the signal. Whether the full text was handed to `saveArtifact` is.
 */
async function spilledAtTurn(payload: string, turnIndex: number): Promise<boolean> {
	const tool = wrapToolWithMetaNotice({
		name: "bulk",
		label: "Bulk",
		summary: "returns the payload it was built with",
		description: "returns the payload it was built with",
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text", text: payload }] }),
	} as unknown as AgentTool);

	// The spill is a no-op without a session manager to hold the artifact, so give it one that
	// records rather than writes: what is under test is the threshold, not the persistence.
	const saved: string[] = [];
	const context = {
		getTurnIndex: () => turnIndex,
		sessionManager: {
			saveArtifact: async (full: string) => {
				saved.push(full);
				return `artifact-${saved.length}`;
			},
		},
	} as unknown as AgentToolContext;
	await tool.execute("spill-1", {} as never, undefined, undefined, context);

	return saved.length > 0;
}

describe("centralised artifact spill", () => {
	/**
	 * The other half of the same defect. `spillLargeResultToArtifact` governs every tool that does
	 * NOT stream: MCP tools, extension and custom tools, RPC-host tools, and any built-in without an
	 * `OutputSink`. It read a flat 50KB threshold while the streaming tools were turn-priced, so the
	 * same bytes cost one thing arriving from `eval` and another arriving from an MCP server.
	 *
	 * Driven through the real wrapper rather than read out of `output-meta.ts`. The retained tail is
	 * a fixed size, so what the turn changes is WHETHER a result spills at all.
	 *
	 * The curve tightens EARLY, not late: a result arriving at turn 0 sits in context for the whole
	 * session and gets the smaller budget, while a result arriving near the end is nearly free and
	 * gets the flat one. So a payload sized between the two is cut at turn 0 and survives whole at
	 * turn 80. A flat threshold keeps it whole at both, which is exactly the regression, and no
	 * check that only looks for the call can see it.
	 */
	it("prices its threshold by the turn, like the streaming tools", async () => {
		const earlyBudget = inlineBudgetFor({ getTurnIndex: () => 0 });
		const lateBudget = inlineBudgetFor({ getTurnIndex: () => 80 });
		// The premise: the curve really does move with the turn. Without this the sizing below would
		// be arbitrary and the case could pass for the wrong reason.
		expect(earlyBudget).toBeLessThan(lateBudget);

		const payload = "x".repeat(Math.floor((earlyBudget + lateBudget) / 2));
		expect(await spilledAtTurn(payload, 0), "turn 0 must spill: the payload is over the early budget").toBe(true);
		expect(await spilledAtTurn(payload, 80), "turn 80 must not: the same payload is under the flat one").toBe(
			false,
		);
	});
});

describe("the pricing owner", () => {
	/**
	 * A host with no notion of turns must still work, and must get the flat behaviour rather than an
	 * accidental floor. Asserted by CALLING the owner with and without a turn index rather than by
	 * reading `getTurnIndex?: () => number;` out of the context type: what matters is that the absent
	 * case produces the flat budget instead of throwing or flooring to zero.
	 */
	it("leaves the turn index optional so a turn-less host is unpriced, not mis-priced", () => {
		const turnless = inlineBudgetFor({});
		expect(turnless).toBeGreaterThan(0);
		expect(Number.isFinite(turnless)).toBe(true);

		// A host that DOES know its turn is priced by it, which is what makes the absence meaningful.
		expect(inlineBudgetFor({ getTurnIndex: () => 40 })).toBeLessThan(turnless);
	});

	/**
	 * The owner has to accept every caller that needs it, or a caller with the right data but the
	 * wrong nominal type invents its own budget again. Asserted by handing it a bare object literal
	 * that is not a `ToolSession` and never was: if the parameter were narrowed to a nominal session
	 * type this stops compiling, which is a stronger statement than finding the words
	 * `inlineBudgetFor(session: InlinePricingSource` in the file.
	 */
	it("keeps the pricing owner structural, not tied to ToolSession", () => {
		const structural: InlinePricingSource = { getTurnIndex: () => 3 };
		expect(inlineBudgetFor(structural)).toBeGreaterThan(0);
		expect(inlineBudgetFor({ getTurnIndex: () => 3, settings: undefined })).toBe(inlineBudgetFor(structural));
	});
});

/**
 * What the source-shape checks above cannot see: the number the setting produces.
 *
 * WHY THIS EXISTS ALONGSIDE THEM. The structural locks catch a NEW call site that forgets to
 * price its budget, which no behavioural test can see because nothing breaks when it happens.
 * They cannot catch the opposite: a call site that prices correctly through an owner whose
 * arithmetic is wrong. `tools.artifactSpillThreshold` is in KILOBYTES and the budget is in
 * BYTES, so a dropped multiplication makes every tool spill after 50 bytes and every one of the
 * shape assertions still passes. That conversion, and the refusals around it, are pinned here.
 */
describe("the priced budget, as a number", () => {
	/** A settings stand-in that answers only the two keys the pricing owner reads. */
	function settingsWith(values: Record<string, unknown>): Settings {
		return { get: (key: string) => values[key] } as unknown as Settings;
	}

	/**
	 * The setting is kilobytes and the answer is bytes.
	 *
	 * The one arithmetic step in the whole path, and the one that would make every tool result
	 * spill at 8 bytes if it were dropped.
	 */
	it("reads the configured threshold as kilobytes", () => {
		expect(inlineBudgetFor({ settings: settingsWith({ "tools.artifactSpillThreshold": 8 }) })).toBe(8 * 1024);
		expect(inlineBudgetFor({ settings: settingsWith({ "tools.artifactSpillThreshold": 200 }) })).toBe(200 * 1024);
	});

	/**
	 * A host with no turn index gets the flat configured budget, not a floor of it.
	 *
	 * This is the case the centralised spill hits from an MCP server or an extension tool, and
	 * mis-pricing it was the original defect: those callers invented their own flat number
	 * because the priced owner demanded a session type they did not have.
	 */
	it("returns the flat threshold when the caller has no turns", () => {
		expect(inlineBudgetFor({ settings: settingsWith({ "tools.artifactSpillThreshold": 64 }) })).toBe(64 * 1024);
	});

	/**
	 * An explicit ceiling from the caller still wins.
	 *
	 * grep passes one because it keeps a head window only. The argument has to keep working even
	 * though the spill no longer passes it, or the next caller that needs it will read the
	 * setting itself instead.
	 */
	it("lets a caller bound the budget below the configured one", () => {
		const settings = settingsWith({ "tools.artifactSpillThreshold": 200 });
		expect(inlineBudgetFor({ settings }, 4096)).toBe(4096);
	});

	/**
	 * A threshold of zero or a non-finite one is refused, not honoured.
	 *
	 * Zero elides every tool result down to its ellipsis and a NaN propagates into every byte
	 * comparison so that nothing spills at all. Both fall back to the compiled default, which is
	 * the same answer as not setting it, and the refusal is logged rather than silent (Law 10).
	 */
	it("refuses a threshold that is not a positive number of kilobytes", () => {
		const unconfigured = inlineBudgetFor({ settings: settingsWith({}) });
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(inlineBudgetFor({ settings: settingsWith({ "tools.artifactSpillThreshold": bad }) })).toBe(
				unconfigured,
			);
		}
	});
});
