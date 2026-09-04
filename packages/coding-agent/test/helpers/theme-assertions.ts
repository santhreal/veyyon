import { afterAll, beforeAll, expect } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme, type ThemeColor, theme } from "@veyyon/coding-agent/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, TERMINAL } from "@veyyon/tui";
import { sanitizeText } from "@veyyon/utils";

/**
 * Install `name` as the process-wide theme for the calling suite, built TRUECOLOR, and put the
 * previous instance back afterwards.
 *
 * WHY A SUITE MUST NOT HAND-ROLL THIS. Two things about the theme are easy to get half right, and
 * a suite that gets either one wrong is green for the wrong reason.
 *
 * The first is the build. A mix — a fading band, a card unfolding out of the ground — only runs on
 * the truecolor branch, and a `Theme` fixes its colour mode at CONSTRUCTION from the environment.
 * A suite that loads a theme without pinning `COLORTERM` first asserts the 256-colour branch on a
 * plain terminal, which is how a band test passes while the band is broken.
 *
 * The second is the restore, and it is the one that bites somebody else. `setThemeInstance` is
 * process-wide and `bun test` runs a bucket's files in one process, so a suite that installs a
 * truecolor theme and restores only `COLORTERM` and the ANSI policy leaves the INSTANCE behind —
 * and the instance still reports truecolor however the environment reads afterwards. Every later
 * file then renders a gradient where it expects the flat switched band. Three suites did exactly
 * this and the bill landed on seventeen innocent tests in `modes/components`: pointer bands,
 * selector overlays, the session tree card and `HistorySearchComponent` all failed in the full
 * bucket and passed alone, which reads as flake rather than as a leak.
 *
 * Call it at the top level of the `describe` that needs colour, like {@link useFullColor}, which
 * this also does — a truecolor theme with the policy off still paints nothing.
 */
export function useTruecolorTheme(name: string): void {
	// `TERMINAL` declares the capability readonly; a suite that drives colour has to write it.
	const terminalCaps: { trueColor: boolean } = TERMINAL;
	let previousPolicy: AnsiPolicy;
	let previousTheme: Theme | undefined;
	let previousColorterm: string | undefined;
	let previousTrueColor: boolean;
	beforeAll(async () => {
		previousPolicy = getAnsiPolicy();
		previousTheme = theme;
		previousColorterm = Bun.env.COLORTERM;
		previousTrueColor = terminalCaps.trueColor;
		setAnsiPolicy("full");
		Bun.env.COLORTERM = "truecolor";
		terminalCaps.trueColor = true;
		const loaded = await getThemeByName(name);
		if (!loaded) throw new Error(`${name} theme unavailable in test env`);
		if (loaded.getColorMode() !== "truecolor") throw new Error(`${name} built as ${loaded.getColorMode()}`);
		setThemeInstance(loaded);
	});
	afterAll(() => {
		// `trueColor` first, and never omitted: it is the one a later `initTheme` reads, so leaving it
		// set hands every subsequent suite a truecolor theme however its own environment reads.
		terminalCaps.trueColor = previousTrueColor;
		setAnsiPolicy(previousPolicy);
		if (previousColorterm === undefined) delete (Bun.env as Record<string, string | undefined>).COLORTERM;
		else Bun.env.COLORTERM = previousColorterm;
		if (previousTheme !== undefined) setThemeInstance(previousTheme);
	});
}

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
