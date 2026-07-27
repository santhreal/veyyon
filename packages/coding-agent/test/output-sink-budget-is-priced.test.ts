import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "@veyyon/coding-agent/config/settings";
import { inlineBudgetFor } from "@veyyon/coding-agent/tools/output-artifact";

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
	 * An executor with no session cannot price anything, so it must take the
	 * number as an option instead of inventing one. This pins that the three
	 * session-less executors actually expose the field.
	 */
	it("lets a session-less executor receive a budget from its caller", () => {
		for (const relative of [
			path.join("exec", "bash-executor.ts"),
			path.join("ssh", "ssh-executor.ts"),
			path.join("tools", "bash-interactive.ts"),
		]) {
			const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
			expect(source).toContain("spillThreshold?: number;");
		}
	});
});

describe("centralised artifact spill", () => {
	const OUTPUT_META = path.join(ROOT, "tools", "output-meta.ts");

	/**
	 * The other half of the same defect. `spillLargeResultToArtifact` governs every
	 * tool that does NOT stream: MCP tools, extension and custom tools, RPC-host
	 * tools, and any built-in without an `OutputSink`. It read a flat 50KB
	 * threshold while the streaming tools were turn-priced, so the same bytes cost
	 * one thing arriving from `eval` and another arriving from an MCP server.
	 */
	it("prices its threshold through the same owner as the streaming tools", () => {
		const source = fs.readFileSync(OUTPUT_META, "utf8");
		expect(source).toContain("inlineBudgetFor(");
		// And through it ONLY. The spill used to pass the flat setting back in as a
		// ceiling, which read as belt and braces and was really a second way to
		// spell the same read: `inlineOutputPricing` reads
		// `tools.artifactSpillThreshold` itself. Two readers of one setting is how
		// the two owners this suite exists for came about in the first place, so the
		// second argument staying absent is part of the contract.
		expect(source).not.toContain(
			"inlineBudgetFor({ getTurnIndex: context?.getTurnIndex, settings: context?.settings },",
		);
	});

	/**
	 * A host with no notion of turns must still work, and must get the flat
	 * behaviour rather than an accidental floor. That is why the turn index is
	 * optional all the way through, and this pins the optionality at the type.
	 */
	it("leaves the turn index optional so a turn-less host is unpriced, not mis-priced", () => {
		const context = fs.readFileSync(path.join(ROOT, "extensibility", "custom-tools", "types.ts"), "utf8");
		expect(context).toContain("getTurnIndex?: () => number;");
	});

	/**
	 * The owner has to accept every caller that needs it, or a caller with the
	 * right data but the wrong nominal type invents its own budget again. That is
	 * precisely how the two owners came about, so the structural type is the fix
	 * and it is asserted rather than assumed.
	 */
	it("keeps the pricing owner structural, not tied to ToolSession", () => {
		const source = fs.readFileSync(path.join(ROOT, "tools", "output-artifact.ts"), "utf8");
		expect(source).toContain("export interface InlinePricingSource");
		expect(source).toContain("inlineBudgetFor(session: InlinePricingSource");
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
