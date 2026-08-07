import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { buildComposerShortcuts, ComposerShortcutsBar } from "@veyyon/coding-agent/modes/components/composer-shortcuts";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { useFullColor } from "../../helpers/theme-assertions";

await initTheme(false, "unicode", false, "titanium", "light");

describe("composer contextual shortcuts", () => {
	useFullColor();

	it("surfaces the interrupt chip only while busy", () => {
		const kb = KeybindingsManager.inMemory();
		const idle = buildComposerShortcuts(kb, {
			busy: false,
			hasDraft: true,
			hasQueue: false,
			canBackgroundBash: false,
			focused: false,
		});
		const busy = buildComposerShortcuts(kb, {
			busy: true,
			hasDraft: true,
			hasQueue: false,
			canBackgroundBash: false,
			focused: false,
		});
		// Quiet composer: no idle chrome — the interrupt chip is the live action.
		expect(idle.length).toBe(0);
		expect(busy.some(c => c.label.includes("interrupt"))).toBe(true);
	});

	it("renders chip grammar matching ModalShell footers", () => {
		const bar = new ComposerShortcutsBar();
		bar.setShortcuts([{ label: "enter send" }, { label: "esc close", clickable: true, id: "close" }]);
		const plain = stripVTControlCharacters(bar.render(80).join("\n"));
		expect(plain).toContain("enter");
		expect(plain).toContain("send");
		// One separator grammar across the whole TUI: the middle dot `·`, not the
		// old `|` holdout (see modal-shell.ts SHORTCUT_SEP). The bar renders through
		// the same renderModalShortcuts as ModalShell footers, so it matches.
		expect(plain).toContain("·");
	});

	it("stays empty when neither busy nor queued — the quiet idle contract", () => {
		const kb = KeybindingsManager.inMemory();
		const idle = buildComposerShortcuts(kb, {
			busy: false,
			hasDraft: false,
			hasQueue: false,
			canBackgroundBash: false,
			focused: false,
		});
		expect(idle.length).toBe(0);
	});

	// Scroll position is NOT the composer's business. This row used to be
	// overwritten with "↓ N rows up · click to go to the bottom" whenever the
	// transcript was frozen, so scrolling up during a run took away the `esc
	// interrupt` chip. The engine draws the position on the right edge of the
	// region that actually scrolled, and the composer zone renders the same bytes
	// in both states.
	it("keeps its own chips while the transcript is scrolled — no scroll readout in the composer", () => {
		const kb = KeybindingsManager.inMemory();
		const bar = new ComposerShortcutsBar();
		bar.setShortcuts(
			buildComposerShortcuts(kb, {
				busy: true,
				hasDraft: false,
				hasQueue: false,
				canBackgroundBash: false,
				focused: false,
			}),
		);
		const following = bar.render(80);
		// Nothing about scroll state can reach this component: there is no
		// setter to feed it, so a frozen view cannot change what it renders.
		expect("setScrollState" in bar).toBe(false);
		expect(bar.render(80)).toEqual(following);
		const plain = stripVTControlCharacters(following[0]!);
		expect(plain).toContain("interrupt");
		expect(plain).not.toContain("rows up");
		expect(plain).not.toContain("bottom");
	});

	// The band left-aligns at the composer rail (COMPOSER_INSET_COLS), under
	// the footline's location group — one shared axis with the row above,
	// instead of a terminal-centered position whose relationship to the
	// footline changed with every content state (operator review 2026-07-23).
	it("aligns band content at the composer rail", () => {
		const kb = KeybindingsManager.inMemory();
		const bar = new ComposerShortcutsBar();
		bar.setShortcuts(
			buildComposerShortcuts(kb, {
				busy: true,
				hasDraft: false,
				hasQueue: false,
				canBackgroundBash: false,
				focused: false,
			}),
		);
		const rows = bar.render(80);
		expect(rows.length).toBe(1);
		const plain = stripVTControlCharacters(rows[0]!);
		expect(plain.startsWith("  escape")).toBe(true);
	});

	// Regression lock for the footer jump: a band that renders 0 rows idle and 1
	// row busy changes the composer zone's height on every busy flip, jerking the
	// whole footer vertically. The band is fixed-height: exactly one row in every
	// state.
	it("renders exactly one row in every state so the footer height never changes", () => {
		const kb = KeybindingsManager.inMemory();
		const bar = new ComposerShortcutsBar();
		bar.setShortcuts(
			buildComposerShortcuts(kb, {
				busy: false,
				hasDraft: false,
				hasQueue: false,
				canBackgroundBash: false,
				focused: false,
			}),
		);
		const idleRows = bar.render(80);
		expect(idleRows.length).toBe(1);
		expect(stripVTControlCharacters(idleRows[0]!).trim()).toBe("");
		bar.setShortcuts(
			buildComposerShortcuts(kb, {
				busy: true,
				hasDraft: false,
				hasQueue: true,
				canBackgroundBash: false,
				focused: false,
			}),
		);
		const busyRows = bar.render(80);
		expect(busyRows.length).toBe(1);
		expect(stripVTControlCharacters(busyRows[0]!).trim()).not.toBe("");
		// Narrow terminals keep the same one-row reservation.
		expect(bar.render(10).length).toBe(1);
	});

	it("adds the dequeue chip only while the queue is nonempty, in any busy/draft state", () => {
		const kb = KeybindingsManager.inMemory();
		const noQueue = buildComposerShortcuts(kb, {
			busy: false,
			hasDraft: false,
			hasQueue: false,
			canBackgroundBash: false,
			focused: false,
		});
		const queued = buildComposerShortcuts(kb, {
			busy: false,
			hasDraft: false,
			hasQueue: true,
			canBackgroundBash: false,
			focused: false,
		});
		const busyQueued = buildComposerShortcuts(kb, {
			busy: true,
			hasDraft: false,
			hasQueue: true,
			canBackgroundBash: false,
			focused: false,
		});
		expect(noQueue.some(c => c.label.includes("dequeue"))).toBe(false);
		expect(queued.some(c => c.label.includes("dequeue"))).toBe(true);
		expect(busyQueued.some(c => c.label.includes("dequeue"))).toBe(true);
		expect(busyQueued.some(c => c.label.includes("interrupt"))).toBe(true);
	});

	it("never renders the ember accent chrome — chips stay silver/muted (brand: no invented orange chips)", () => {
		const kb = KeybindingsManager.inMemory();
		const bar = new ComposerShortcutsBar();
		bar.setShortcuts(
			buildComposerShortcuts(kb, {
				busy: true,
				hasDraft: false,
				hasQueue: true,
				canBackgroundBash: false,
				focused: false,
			}),
		);
		const raw = bar.render(80).join("\n");
		// "accent" is silver (the structural chip/key color) in this brand —
		// ember/sun is a separate, rare role reserved for links/carets and
		// must never leak into the chip band. Check against that role, not
		// "accent" itself.
		const [emberOpen] = theme.fg("mdLink", "\u0000").split("\u0000");
		expect(raw).not.toContain(emberOpen);
	});
});
