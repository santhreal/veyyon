import { describe, expect, test } from "bun:test";
import { clampTimeout, formatTimeoutClampNotice, TOOL_TIMEOUTS } from "@veyyon/coding-agent/tools/tool-timeouts";

/**
 * SWEEP-LSP-STUB, second half: the `tools.maxTimeout` setting must actually
 * govern the LSP timeout.
 *
 * `LspTool.execute` reads `this.session.settings.get("tools.maxTimeout")` and
 * feeds it to `clampTimeout`. Nothing tested that wiring, and the cost was
 * concrete: when the read was added, all 15 `lsp regressions` tests began dying
 * on a session stub with no `settings` — so the read was simultaneously
 * untested AND the thing breaking every other LSP test. Fixing the stub makes
 * those tests run again; it does not prove the setting does anything, which is
 * what this file is for.
 *
 * The contract has a shape worth stating precisely, because two plausible
 * readings are wrong:
 *
 *  - The setting is a CEILING, not a value. It can only lower the effective
 *    timeout, never raise it above what the caller asked for.
 *  - `0` (and any non-positive value) means "no ceiling", not "time out
 *    immediately". Treating it as a real cap would clamp every LSP call to the
 *    floor and look like a hang-free tool that never finishes anything.
 *
 * Assertions are written against `TOOL_TIMEOUTS.lsp` rather than today's
 * numbers, so a retuned range keeps testing the rule instead of failing on a
 * value that was deliberately changed.
 */
describe("the tools.maxTimeout setting governs the LSP timeout", () => {
	const lsp = TOOL_TIMEOUTS.lsp;

	test("the range this suite reasons about is a real one", () => {
		// Guards every relative assertion below: they only mean something while the
		// floor is genuinely below the ceiling and a default sits inside.
		expect(lsp.min).toBeLessThan(lsp.max);
		expect(lsp.default).toBeGreaterThanOrEqual(lsp.min);
		expect(lsp.default).toBeLessThanOrEqual(lsp.max);
	});

	describe("as a ceiling on the requested value", () => {
		test("a setting below the request lowers the effective timeout to the setting", () => {
			const requested = lsp.max;
			const ceiling = Math.max(lsp.min, Math.floor((lsp.min + lsp.max) / 2));

			expect(clampTimeout("lsp", requested, ceiling)).toBe(ceiling);
		});

		test("a setting above the request leaves the request alone", () => {
			// The direction that must NOT apply: a generous ceiling is permission, not
			// an instruction to extend a caller who asked for less.
			const requested = lsp.min;

			expect(clampTimeout("lsp", requested, lsp.max)).toBe(requested);
		});

		test("no setting at all falls to the tool's own default", () => {
			// The unconfigured case, which is what almost every session runs.
			expect(clampTimeout("lsp", undefined, undefined)).toBe(lsp.default);
		});

		test("the setting cannot push the timeout below the tool's floor", () => {
			// A user typing `tools.maxTimeout: 1` must not make every LSP request
			// unusable; the floor is the tool's own contract and outranks the knob.
			expect(clampTimeout("lsp", lsp.max, 1)).toBe(lsp.min);
		});

		test("the setting cannot raise a request above the tool's ceiling", () => {
			expect(clampTimeout("lsp", lsp.max * 10, lsp.max * 10)).toBe(lsp.max);
		});
	});

	describe("zero and negative mean no ceiling, not an instant deadline", () => {
		test("a zero setting leaves the requested timeout untouched", () => {
			// If `0` were treated as a real cap, `Math.min` would drive every call to
			// the floor and LSP would appear to work while timing out constantly.
			expect(clampTimeout("lsp", lsp.max, 0)).toBe(lsp.max);
		});

		test("a negative setting is ignored the same way", () => {
			expect(clampTimeout("lsp", lsp.max, -30)).toBe(lsp.max);
		});
	});

	describe("the clamp is reported, never applied silently", () => {
		test("lowering the timeout produces a notice naming both values and the range", () => {
			// Law 10 in its literal form: the agent asked for a budget and got a
			// different one, so it has to be told, with enough detail to pick a legal
			// value next time.
			const ceiling = Math.max(lsp.min, Math.floor((lsp.min + lsp.max) / 2));
			const effective = clampTimeout("lsp", lsp.max, ceiling);

			expect(formatTimeoutClampNotice("lsp", lsp.max, effective)).toBe(
				`Timeout clamped to ${effective}s (requested ${lsp.max}s; allowed range ${lsp.min}-${lsp.max}s).`,
			);
		});

		test("an honored request produces no notice", () => {
			// The control. Without it, a notice generator that fired unconditionally
			// would pass the test above and cry wolf on every single call.
			expect(formatTimeoutClampNotice("lsp", lsp.min, clampTimeout("lsp", lsp.min, lsp.max))).toBeUndefined();
		});

		test("an omitted request produces no notice, even though a default was applied", () => {
			// Deliberate: nothing was clamped FROM anything. Reporting "clamped to 30s
			// (requested undefineds)" is the garbage output this case exists to avoid.
			expect(formatTimeoutClampNotice("lsp", undefined, clampTimeout("lsp", undefined, 5))).toBeUndefined();
		});
	});
});
