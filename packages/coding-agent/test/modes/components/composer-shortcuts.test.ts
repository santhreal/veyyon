import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager } from "@veyyon/pi-coding-agent/config/keybindings";
import {
	buildComposerShortcuts,
	ComposerShortcutsBar,
} from "@veyyon/pi-coding-agent/modes/components/composer-shortcuts";
import { initTheme, theme } from "@veyyon/pi-coding-agent/modes/theme/theme";

await initTheme(false, "unicode", false, "titanium", "light");

describe("composer contextual shortcuts", () => {
	it("swaps send for interrupt when busy", () => {
		const kb = KeybindingsManager.inMemory();
		const idle = buildComposerShortcuts(kb, { busy: false, hasDraft: true, hasQueue: false });
		const busy = buildComposerShortcuts(kb, { busy: true, hasDraft: true, hasQueue: false });
		expect(idle.some(c => c.label.includes("send"))).toBe(true);
		expect(busy.some(c => c.label.includes("interrupt"))).toBe(true);
		expect(busy.some(c => c.label.includes("send"))).toBe(false);
	});

	it("renders chip grammar matching ModalShell footers", () => {
		const bar = new ComposerShortcutsBar();
		bar.setShortcuts([{ label: "enter send" }, { label: "esc close", clickable: true, id: "close" }]);
		const plain = stripVTControlCharacters(bar.render(80).join("\n"));
		expect(plain).toContain("enter");
		expect(plain).toContain("send");
		expect(plain).toContain("|");
	});

	it("falls back to the idle '/ commands' chip when neither busy nor drafting", () => {
		const kb = KeybindingsManager.inMemory();
		const idle = buildComposerShortcuts(kb, { busy: false, hasDraft: false, hasQueue: false });
		expect(idle.some(c => c.label.includes("commands"))).toBe(true);
		expect(idle.some(c => c.label.includes("send"))).toBe(false);
		expect(idle.some(c => c.label.includes("interrupt"))).toBe(false);
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
