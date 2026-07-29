/**
 * WHICH BUG THIS LOCKS OUT: a throwing theme-change listener was mistaken for a
 * broken theme, so a theme that loaded perfectly was rolled back and the user
 * was dropped onto the dark fallback.
 *
 * `notifyThemeChange` invokes the single registered listener bare. That listener
 * is the UI's repaint hook: render-cache invalidation, mermaid cache, the editor
 * border colour, native scrollback replacement. It is called from three places
 * that each mis-handle a throw from it in a different way:
 *
 *   - `applyTheme`'s success path calls it INSIDE the try. A listener throw is
 *     caught by the `catch` written for a FAILED LOAD, which commits
 *     `currentThemeName` to the fallback, swaps the active theme to dark, and
 *     returns `{ success: false, fellBack: true }`. The theme had already been
 *     applied one line earlier. The user asked for light, got dark, and was told
 *     their theme file was broken.
 *   - `applyTheme`'s fallback path calls it again INSIDE the catch, where
 *     nothing is left to catch it, so `setTheme` rejects into its caller.
 *   - the theme file watcher and the auto-theme observer call it inside a
 *     `.then()` whose sibling `.catch` exists for load failures. There, a broken
 *     repaint hook silently rolls `currentThemeName` back to the previous name
 *     while `setActiveTheme` has already succeeded, leaving the tracked name
 *     disagreeing with the live theme for the rest of the session.
 *
 * This is the same shape as the secret-expansion guard: a failure in one
 * subsystem attributed to another, and a recovery run for a problem that never
 * happened.
 *
 * WHAT BREAKS IF THIS REGRESSES: remove the try/catch in `notifyThemeChange` and
 * any exception in the repaint hook turns every theme change into a spurious
 * "your theme is broken, here is dark instead".
 *
 * The epoch is bumped before the listener runs, so the next render re-shapes
 * regardless. A dead repaint hook is a logged warning, never a rolled-back theme.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import {
	getCurrentThemeName,
	getThemeByName,
	getThemeEpoch,
	onThemeChange,
	setTheme,
	setThemeInstance,
	type Theme,
	type ThemeChangeEvent,
} from "@veyyon/coding-agent/modes/theme/theme";
import { logger } from "@veyyon/utils";

/** One captured `logger.warn` call. */
interface WarnEntry {
	message: string;
	fields?: Record<string, unknown>;
}

/** A live `logger.warn` capture plus its restore hook. */
interface WarnCapture {
	entries: WarnEntry[];
	restore: () => void;
}

/**
 * Capture `logger.warn` so the degradation is asserted to be LOUD.
 *
 * Silently swallowing the listener throw would also stop the false fallback, and
 * would be the wrong fix: a repaint hook that never runs means the screen stops
 * matching the theme, and nobody would ever find out why.
 */
function captureWarnings(): WarnCapture {
	const entries: WarnEntry[] = [];
	const spy = vi.spyOn(logger, "warn").mockImplementation(((message: string, fields?: Record<string, unknown>) => {
		entries.push({ message, fields });
	}) as unknown as typeof logger.warn);
	return { entries, restore: () => spy.mockRestore() };
}

let dark: Theme;
let warnings: WarnCapture | undefined;
let releaseListener: (() => void) | undefined;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Expected the built-in dark theme to exist");
	dark = loaded;
});

afterEach(() => {
	releaseListener?.();
	releaseListener = undefined;
	warnings?.restore();
	warnings = undefined;
	// Leave a deterministic active theme for any later case in this process.
	setThemeInstance(dark);
});

/** Register a theme-change listener that always throws, and return its call count. */
function installBrokenListener(thrown: unknown = new Error("repaint hook exploded")): { calls: number } {
	const state = { calls: 0 };
	releaseListener = onThemeChange(() => {
		state.calls++;
		throw thrown;
	});
	return state;
}

describe("a theme-change listener that throws", () => {
	/**
	 * THE regression. `light` is a built-in and always loads. With the listener
	 * throw escaping, `applyTheme`'s catch reports the load as failed and swaps
	 * the user onto the dark fallback.
	 */
	it("does not turn a theme that loaded fine into a fallback", async () => {
		warnings = captureWarnings();
		const broken = installBrokenListener();

		const result = await setTheme("light");

		expect(broken.calls).toBeGreaterThan(0);
		expect(result.success).toBe(true);
		expect(result.fellBack).toBeUndefined();
	});

	/** The name the rest of the session reads must be the theme the user asked for. */
	it("leaves the requested theme committed as the active one", async () => {
		warnings = captureWarnings();
		installBrokenListener();

		await setTheme("light");

		expect(getCurrentThemeName()).toBe("light");
	});

	/**
	 * The epoch is what memoized renderers key on. It is bumped before the
	 * listener runs, so a broken repaint hook must not also cost the next render
	 * its invalidation.
	 */
	it("still advances the theme epoch", async () => {
		warnings = captureWarnings();
		installBrokenListener();
		const before = getThemeEpoch();

		await setTheme("light");

		expect(getThemeEpoch()).toBeGreaterThan(before);
	});

	/** A broken repaint hook is a real problem; it just is not a theme problem. */
	it("reports the broken listener at warn", async () => {
		warnings = captureWarnings();
		installBrokenListener();

		await setTheme("light");

		const reported = warnings.entries.filter(e => e.message.includes("Theme change listener threw"));
		expect(reported).toHaveLength(1);
		expect(String(reported[0]?.fields?.error)).toContain("repaint hook exploded");
	});

	/**
	 * ADVERSARIAL: a repaint hook that is broken stays broken. The second theme
	 * change must behave exactly like the first rather than latching into a
	 * permanently-failing state.
	 */
	it("keeps applying later theme changes", async () => {
		warnings = captureWarnings();
		const broken = installBrokenListener();

		const first = await setTheme("light");
		const second = await setTheme("dark");

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		expect(getCurrentThemeName()).toBe("dark");
		expect(broken.calls).toBe(2);
	});

	/**
	 * BOUNDARY: a listener that throws a non-Error. Containment that assumed an
	 * `Error` would rethrow while formatting the report.
	 */
	it("contains a listener that throws a non-Error value", async () => {
		warnings = captureWarnings();
		installBrokenListener("a bare string, not an Error");

		const result = await setTheme("light");

		expect(result.success).toBe(true);
		expect(warnings.entries.some(e => e.message.includes("Theme change listener threw"))).toBe(true);
	});

	/**
	 * NEGATIVE: a healthy listener must still be called, still receive its event,
	 * and produce no warning. Containment that quietly stopped invoking listeners
	 * would pass every assertion above and break the UI completely.
	 */
	it("delivers the event normally and says nothing when the listener is healthy", async () => {
		warnings = captureWarnings();
		const seen: ThemeChangeEvent[] = [];
		releaseListener = onThemeChange(event => {
			seen.push(event);
		});

		const result = await setTheme("light");

		expect(result.success).toBe(true);
		expect(seen).toHaveLength(1);
		expect(warnings.entries.filter(e => e.message.includes("Theme change listener threw"))).toEqual([]);
	});
});
