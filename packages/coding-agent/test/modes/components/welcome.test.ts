import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings, settings } from "@veyyon/pi-coding-agent/config/settings";
import {
	pickWeightedTip,
	WelcomeComponent,
} from "@veyyon/pi-coding-agent/modes/components/welcome";
import { initTheme, theme } from "@veyyon/pi-coding-agent/modes/theme/theme";

function plain(lines: readonly string[]): string {
	return lines.map(line => stripVTControlCharacters(line)).join("\n");
}

const NERDFONT_TIP = "Please use nerdfont for the best symbol rendering.";

describe("WelcomeComponent tips", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("selects standard tip when preset is not unicode", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("nerd");

		const welcome = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcome.tip).not.toBe(NERDFONT_TIP);
		expect(welcome.tip).toBeDefined();
	});

	it("selects nerdfont tip with 10% probability under unicode preset", () => {
		vi.spyOn(theme, "getSymbolPreset").mockReturnValue("unicode");

		// 9% chance => selects special tip
		vi.spyOn(Math, "random").mockReturnValue(0.09);
		const welcomeSpecial = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcomeSpecial.tip).toBe(NERDFONT_TIP);

		// 10% chance => selects regular tip
		vi.spyOn(Math, "random").mockReturnValue(0.1);
		const welcomeRegular = new WelcomeComponent("1.0.0", "model", "provider");
		expect(welcomeRegular.tip).not.toBe("Please use nerdfont 😭.");
		expect(welcomeRegular.tip).toBeDefined();
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(0);
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});
});

describe("WelcomeComponent sunrise home layout", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false, "unicode", false, "titanium", "light");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders the sun, the silver wordmark, and quiet metadata with no box rails", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const welcome = new WelcomeComponent("1.2.3", "claude-sonnet-4-5", "anthropic");
		const lines = welcome.render(80);
		const frame = plain(lines);

		// The sun is present (dithered block glyphs) and the letterspaced text
		// wordmark (the terminal's own font, not glyph art) follows it.
		expect(frame).toContain("█");
		expect(frame).toContain("v e y y o n");
		// The sunrise home is an open composition: no card rails or corners.
		for (const rail of ["│", "┌", "┐", "└", "┘"]) {
			expect(frame).not.toContain(rail);
		}
		// One metadata line carries version, model, and provider together.
		expect(frame).toContain("v1.2.3 · claude-sonnet-4-5 · anthropic");
		expect(frame).toContain("Hashline edits that land. Your keys.");
		// Centred: the wordmark row leads with real left margin at width 80.
		const wordmarkRow = lines.map(line => stripVTControlCharacters(line)).find(line => line.includes("v e y y o n"));
		expect(wordmarkRow?.match(/^ */)?.[0].length ?? 0).toBeGreaterThan(10);
	});

	it("keeps the home free of tips, menu rows, and recents — those live on /welcome", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const sessions = [{ name: "fix-the-parser", timeAgo: "2h ago" }];
		const home = plain(new WelcomeComponent("1.2.3", "gpt-5", "openai", sessions).render(80));
		expect(home).toContain("/welcome");
		expect(home).not.toContain("Tip:");
		expect(home).not.toContain("Resume session");
		expect(home).not.toContain("fix-the-parser");

		const full = new WelcomeComponent("1.2.3", "gpt-5", "openai", sessions, [], true);
		const fullFrame = plain(full.render(80));
		expect(fullFrame).toContain("Resume session");
		expect(fullFrame).toContain("Settings");
		expect(fullFrame).toContain("fix-the-parser");
		expect(fullFrame).toContain("Tip:");
		// The full page is the home plus the menu column — strictly taller.
		expect(full.render(80).length).toBeGreaterThan(
			new WelcomeComponent("1.2.3", "gpt-5", "openai", sessions).render(80).length,
		);
	});

	it("renders a /login call to action instead of a dead 'Unknown' line when no model is set", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const welcome = new WelcomeComponent("1.2.3", "", "");
		const frame = plain(welcome.render(80));

		expect(frame).toContain("no model yet");
		expect(frame).toContain("/login");
		// The bare fallback string must never reach the screen.
		expect(frame).not.toContain("Unknown");
	});

	it("scales the sun with the terminal and survives narrow widths", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		for (const width of [40, 60, 80, 120, 200]) {
			const frame = plain(new WelcomeComponent("1.2.3", "gpt-5", "openai").render(width));
			expect(frame).toContain("█");
			expect(frame).toContain("v e y y o n");
		}
		// Under the floor the home renders nothing rather than a broken layout.
		expect(new WelcomeComponent("1.2.3", "gpt-5", "openai").render(20)).toEqual([]);
		// The sun field is wider on a wider terminal.
		const sunRows = (w: number) =>
			new WelcomeComponent("1.2.3", "gpt-5", "openai")
				.render(w)
				.map(line => stripVTControlCharacters(line))
				.filter(line => line.includes("█"));
		const widest = (rows: string[]) => Math.max(...rows.map(row => row.trimEnd().length));
		expect(widest(sunRows(160))).toBeGreaterThan(widest(sunRows(48)));
	});

	it("carries the full selected tip on the wide full card (positive twin)", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const welcome = new WelcomeComponent("1.2.3", "gpt-5", "openai", [], [], true);
		const tip = welcome.tip;
		if (!tip) throw new Error("Expected a selected tip");
		const lastWord =
			tip
				.replace(/\s*\[NEW\]$/, "")
				.split(/\s+/)
				.at(-1) ?? "";
		expect(plain(welcome.render(200))).toContain(lastWord);
	});

	it("shows model and provider on a single info line, not two", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		// Short names so the combined line fits the narrow hero column unclipped.
		const welcome = new WelcomeComponent("1.2.3", "gpt-5", "openai");
		const lines = welcome.render(80).map(line => stripVTControlCharacters(line));

		const infoLineIdx = lines.findIndex(line => line.includes("gpt-5") && line.includes("openai"));
		expect(infoLineIdx).toBeGreaterThan(0);
		// Neither name repeats on a separate row — confirms one shared slot, not two.
		expect(lines.filter(line => line.includes("gpt-5")).length).toBe(1);
		expect(lines.filter(line => line.includes("openai")).length).toBe(1);
	});
});

describe("WelcomeComponent degraded sun path (SUN-4)", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("skips the intro bloom and renders one static settled frame when animations are disabled", () => {
		settings.set("display.shimmer", "disabled");
		try {
			const welcome = new WelcomeComponent("1.2.3", "gpt-5", "openai");
			const intervalSpy = vi.spyOn(globalThis, "setInterval");
			let renders = 0;
			welcome.playIntro(() => {
				renders++;
			});
			// No timer scheduled — the mark rests immediately on the settled frame.
			expect(intervalSpy).not.toHaveBeenCalled();
			expect(renders).toBe(1);
			// Static: two consecutive renders are byte-identical.
			const a = welcome.render(80).join("\n");
			welcome.invalidate();
			expect(welcome.render(80).join("\n")).toBe(a);
		} finally {
			settings.set("display.shimmer", "classic");
		}
	});

	it("plays the bloom timer when animations are enabled (positive twin)", () => {
		settings.set("display.shimmer", "classic");
		const welcome = new WelcomeComponent("1.2.3", "gpt-5", "openai");
		const intervalSpy = vi.spyOn(globalThis, "setInterval");
		welcome.playIntro(() => {});
		try {
			expect(intervalSpy).toHaveBeenCalledTimes(1);
		} finally {
			welcome.stopIntro();
		}
	});
});
