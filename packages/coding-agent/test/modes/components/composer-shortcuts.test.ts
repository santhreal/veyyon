import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { buildComposerShortcuts, ComposerShortcutsBar } from "@veyyon/coding-agent/modes/components/composer-shortcuts";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";

await initTheme(false, "unicode", false, "titanium", "light");

describe("composer contextual shortcuts", () => {
	it("surfaces the interrupt chip only while busy", () => {
		const kb = KeybindingsManager.inMemory();
		const idle = buildComposerShortcuts(kb, { busy: false, hasDraft: true, hasQueue: false });
		const busy = buildComposerShortcuts(kb, { busy: true, hasDraft: true, hasQueue: false });
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
		const idle = buildComposerShortcuts(kb, { busy: false, hasDraft: false, hasQueue: false });
		expect(idle.length).toBe(0);
	});

	// Scroll isolation indicator: while the operator is scrolled up, the band
	// swaps chips for the new-rows readout, still exactly one row so the
	// footer height never changes. The state is read at render time (no
	// rebuild trigger from the engine's wheel handling).
	it("shows the new-rows indicator while scrolled, still exactly one row", () => {
		const bar = new ComposerShortcutsBar();
		bar.setScrollState(() => ({ active: true, newRows: 8 }));
		const rows = bar.render(80);
		expect(rows.length).toBe(1);
		const plain = stripVTControlCharacters(rows[0]!);
		expect(plain).toContain("8 new rows");
		expect(plain).toContain("wheel down to resume");
		bar.setScrollState(() => ({ active: false, newRows: 0 }));
		expect(stripVTControlCharacters(bar.render(80)[0]!).trim()).toBe("");
	});

	// Regression lock for the footer jump (user report 2026-07-22): a band
	// that renders 0 rows idle and 1 row busy changes the composer zone's
	// height on every busy flip, jerking the whole footer vertically. The
	// band is fixed-height: exactly one row in every state.
	it("renders exactly one row in every state so the footer height never changes", () => {
		const kb = KeybindingsManager.inMemory();
		const bar = new ComposerShortcutsBar();
		bar.setShortcuts(buildComposerShortcuts(kb, { busy: false, hasDraft: false, hasQueue: false }));
		const idleRows = bar.render(80);
		expect(idleRows.length).toBe(1);
		expect(stripVTControlCharacters(idleRows[0]!).trim()).toBe("");
		bar.setShortcuts(buildComposerShortcuts(kb, { busy: true, hasDraft: false, hasQueue: true }));
		const busyRows = bar.render(80);
		expect(busyRows.length).toBe(1);
		expect(stripVTControlCharacters(busyRows[0]!).trim()).not.toBe("");
		// Narrow terminals keep the same one-row reservation.
		expect(bar.render(10).length).toBe(1);
	});

	it("adds the dequeue chip only while the queue is nonempty, in any busy/draft state", () => {
		const kb = KeybindingsManager.inMemory();
		const noQueue = buildComposerShortcuts(kb, { busy: false, hasDraft: false, hasQueue: false });
		const queued = buildComposerShortcuts(kb, { busy: false, hasDraft: false, hasQueue: true });
		const busyQueued = buildComposerShortcuts(kb, { busy: true, hasDraft: false, hasQueue: true });
		expect(noQueue.some(c => c.label.includes("dequeue"))).toBe(false);
		expect(queued.some(c => c.label.includes("dequeue"))).toBe(true);
		expect(busyQueued.some(c => c.label.includes("dequeue"))).toBe(true);
		expect(busyQueued.some(c => c.label.includes("interrupt"))).toBe(true);
	});

	it("never renders the ember accent chrome — chips stay silver/muted (brand: no invented orange chips)", () => {
		const kb = KeybindingsManager.inMemory();
		const bar = new ComposerShortcutsBar();
		bar.setShortcuts(buildComposerShortcuts(kb, { busy: true, hasDraft: false, hasQueue: true }));
		const raw = bar.render(80).join("\n");
		// "accent" is silver (the structural chip/key color) in this brand —
		// ember/sun is a separate, rare role reserved for links/carets and
		// must never leak into the chip band. Check against that role, not
		// "accent" itself.
		const [emberOpen] = theme.fg("mdLink", "\u0000").split("\u0000");
		expect(raw).not.toContain(emberOpen);
	});
});
