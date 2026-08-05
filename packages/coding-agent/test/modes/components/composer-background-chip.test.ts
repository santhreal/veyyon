/**
 * The `ctrl+b background` chip: the hint half of manual bash backgrounding.
 *
 * WHY THIS SUITE EXISTS. `app.bash.background` (ctrl+b) has worked since the
 * foreground-bash registry landed: the key is bound, the editor dispatches it,
 * and `requestManualBackground()` resolves the innermost waiting command. The
 * hint was not. `bash-foreground-registry.ts` documents `hasForegroundBashWait`
 * as existing so that "the hint only appears when the key would actually do
 * something", and nothing outside the registry's own tests ever called it, so
 * the key was undiscoverable unless you already knew it or opened `/help`. A
 * shipped capability nobody can find is not shipped.
 *
 * Two contracts are pinned here, and the second is the one that makes the hint
 * honest:
 *
 *  1. The chip appears exactly when a foreground bash is waiting.
 *  2. It appears for NO other reason. In particular it is not derived from
 *     `busy`. The agent is busy for every tool call and for plain streaming, so
 *     a busy-derived chip would advertise ctrl+b during a web fetch or a model
 *     turn, where the key falls through to readline's cursor-left and the
 *     operator's cursor silently jumps a column. Advertising a dead key is worse
 *     than no hint.
 *
 * The registry-to-bar wiring (the subscription that repaints on both edges) is
 * exercised through the registry's own API rather than by mounting the mode, so
 * the failure this suite reports is about the hint and not about TUI mounting.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { buildComposerShortcuts, ComposerShortcutsBar } from "@veyyon/coding-agent/modes/components/composer-shortcuts";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	hasForegroundBashWait,
	onForegroundBashWaitChange,
	registerForegroundBashWait,
	requestManualBackground,
	resetForegroundBashRegistryForTest,
} from "@veyyon/coding-agent/tools/bash-foreground-registry";
import { useFullColor } from "../../helpers/theme-assertions";

await initTheme(false, "unicode", false, "titanium", "light");

/** Every state combination that is not about a waiting bash command. */
const NON_BASH_STATES = [
	{ busy: false, hasDraft: false, hasQueue: false },
	{ busy: false, hasDraft: true, hasQueue: false },
	{ busy: true, hasDraft: false, hasQueue: false },
	{ busy: true, hasDraft: true, hasQueue: false },
	{ busy: true, hasDraft: false, hasQueue: true },
	{ busy: false, hasDraft: false, hasQueue: true },
] as const;

describe("composer background chip", () => {
	useFullColor();

	beforeEach(() => {
		resetForegroundBashRegistryForTest();
	});

	it("shows the chip with the bound key when a foreground bash is waiting", () => {
		const kb = KeybindingsManager.inMemory();
		const chips = buildComposerShortcuts(kb, {
			busy: true,
			hasDraft: false,
			hasQueue: false,
			canBackgroundBash: true,
			focused: false,
		});
		// The exact label, not a substring probe: the chip has to name the key the
		// operator must press, and reading it out of the keybindings manager is
		// what keeps it correct after a rebind.
		expect(chips.map(c => c.label)).toEqual(["escape interrupt", "ctrl+b background"]);
	});

	it("never shows the chip from busy, draft or queue state alone", () => {
		// The defect this locks out. ctrl+b falls through to readline cursor-left
		// when no bash is waiting, so a chip driven by `busy` would promise a key
		// that moves the cursor instead.
		const kb = KeybindingsManager.inMemory();
		for (const state of NON_BASH_STATES) {
			const chips = buildComposerShortcuts(kb, { ...state, canBackgroundBash: false, focused: false });
			expect(chips.some(c => c.label.includes("background"))).toBe(false);
		}
	});

	it("keeps interrupt in its usual position so the chip does not shift under it", () => {
		// Both chips are live during a foreground command and interrupt is the
		// destructive one. It stays first whether or not the command can be
		// backgrounded, so a click or a glance built on a plain streaming turn
		// lands on the same chip here.
		const kb = KeybindingsManager.inMemory();
		const plain = buildComposerShortcuts(kb, {
			busy: true,
			hasDraft: false,
			hasQueue: false,
			canBackgroundBash: false,
			focused: false,
		});
		const withBash = buildComposerShortcuts(kb, {
			busy: true,
			hasDraft: false,
			hasQueue: false,
			canBackgroundBash: true,
			focused: false,
		});
		expect(plain[0]!.label).toBe("escape interrupt");
		expect(withBash[0]!.label).toBe("escape interrupt");
		expect(withBash[1]!.label).toContain("background");
	});

	it("orders background before dequeue when both are live", () => {
		const kb = KeybindingsManager.inMemory();
		const chips = buildComposerShortcuts(kb, {
			busy: true,
			hasDraft: false,
			hasQueue: true,
			canBackgroundBash: true,
			focused: false,
		});
		expect(chips.map(c => c.label.split(" ").pop())).toEqual(["interrupt", "background", "dequeue"]);
		expect(chips[1]!.label).toBe("ctrl+b background");
	});

	it("renders the chip into the one-row band without growing it", () => {
		// The band is fixed-height (footer-jump regression, 2026-07-22). A third
		// chip must not wrap the band to two rows at a normal width.
		const kb = KeybindingsManager.inMemory();
		const bar = new ComposerShortcutsBar();
		bar.setShortcuts(
			buildComposerShortcuts(kb, {
				busy: true,
				hasDraft: false,
				hasQueue: true,
				canBackgroundBash: true,
				focused: false,
			}),
		);
		const rows = bar.render(80);
		expect(rows.length).toBe(1);
		const plain = stripVTControlCharacters(rows[0]!);
		expect(plain).toContain("ctrl+b");
		expect(plain).toContain("background");
	});

	it("tracks the registry on both edges, which is what the subscription is for", () => {
		// The gate value comes from `hasForegroundBashWait()`, and a wait can start
		// and settle without any draft/busy/queue transition to piggyback on. If
		// this ever reported a stale value the chip would linger over a dead key.
		expect(hasForegroundBashWait()).toBe(false);
		const unregister = registerForegroundBashWait(() => {});
		expect(hasForegroundBashWait()).toBe(true);
		unregister();
		expect(hasForegroundBashWait()).toBe(false);
	});

	it("notifies its subscriber on register, unregister and manual background", () => {
		// Three repaint edges, not two: resolving the wait through ctrl+b itself
		// has to clear the chip, and it does so through the unregister the bash
		// tool runs when the wait settles.
		const seen: boolean[] = [];
		onForegroundBashWaitChange(() => seen.push(hasForegroundBashWait()));
		const unregister = registerForegroundBashWait(() => {});
		expect(requestManualBackground()).toBe(true);
		unregister();
		expect(seen).toEqual([true, false]);
	});

	it("hands back an unsubscribe so a torn-down bar stops being repainted", () => {
		// Without this the listener array grew once per mounted mode and every
		// registration repainted bars that no longer exist.
		let calls = 0;
		const unsubscribe = onForegroundBashWaitChange(() => {
			calls++;
		});
		registerForegroundBashWait(() => {})();
		expect(calls).toBe(2);
		unsubscribe();
		registerForegroundBashWait(() => {})();
		expect(calls).toBe(2);
	});
});
