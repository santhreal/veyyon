import { afterAll, beforeAll, expect } from "bun:test";
import type { Theme, ThemeColor } from "@veyyon/coding-agent/modes/theme/theme";
import { getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";

/**
 * Pin the ANSI policy to `full` for the calling suite, and restore it after.
 *
 * WHY A SUITE HAS TO DECLARE THIS. `theme.fg`/`theme.bg` return their input
 * unchanged when the policy is not `full`, so a test that asserts a rendered
 * line carries a particular colour is asserting nothing at all under
 * `NO_COLOR`: the expected value collapses to the bare text and the assertion
 * either passes vacuously or fails on correct output. The policy is read from
 * the environment at module load, so whether such a suite passes depends on the
 * terminal the developer happened to run it in.
 *
 * That is not flake, it is a missing declaration. Eight suites in this package
 * failed in the gate and passed locally for exactly this reason. A suite whose
 * subject is colour must say so, rather than inherit the answer from `TERM`.
 *
 * Call this at the top level of the `describe` that needs colour. Suites that
 * assert the ABSENCE of a colour do not need it: use {@link expectNotColored},
 * which is correct either way.
 */
export function useFullColor(): void {
	let previous: ReturnType<typeof getAnsiPolicy>;
	beforeAll(() => {
		previous = getAnsiPolicy();
		setAnsiPolicy("full");
	});
	afterAll(() => {
		setAnsiPolicy(previous);
	});
}

/**
 * Assert that `line` does not paint `tokens` in `color`.
 *
 * WHY THIS IS NOT A ONE-LINER, and why it lives here rather than in each
 * renderer's own suite. The obvious spelling,
 * `expect(line).not.toContain(theme.fg("accent", token))`, is only correct when
 * the environment emits colour. Under `NO_COLOR`, which is what the test harness
 * sets, `fg()` is the identity function, so the expected value collapses to the
 * bare token and the assertion silently becomes "the header must not contain the
 * word Search". That is the opposite of what it means, and it fails on a
 * perfectly correct header.
 *
 * The symptom is a test that passes in a colour-capable terminal and fails in
 * the gate, which is how it reads as flake rather than as a bug in the
 * assertion. It was found and fixed once in the grep renderer suite, then found
 * again unchanged in the glob renderer suite, so the correct spelling belongs in
 * one place that every renderer suite calls.
 *
 * The property is asserted in whichever form is observable. With colour on, the
 * painted sequence must be absent. With colour off, "not painted" is provable
 * more strongly: the line carries no escape sequences at all.
 */
export function expectNotColored(theme: Theme, line: string, color: ThemeColor, tokens: readonly string[]): void {
	const colourIsOn = tokens.some(token => theme.fg(color, token) !== token);
	if (colourIsOn) {
		for (const token of tokens) expect(line).not.toContain(theme.fg(color, token));
		return;
	}
	expect(line).toBe(sanitizeText(line));
}

/**
 * {@link expectNotColored} for the accent colour, which is the case every tool
 * renderer suite needs: a successful result header must not shout in accent.
 */
export function expectNotAccented(theme: Theme, line: string, tokens: readonly string[]): void {
	expectNotColored(theme, line, "accent", tokens);
}
