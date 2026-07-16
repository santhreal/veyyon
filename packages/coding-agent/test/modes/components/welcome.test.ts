import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings, settings } from "@veyyon/pi-coding-agent/config/settings";
import {
	pickWeightedTip,
	WELCOME_COMPACT_MAX_ROWS,
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

describe("WelcomeComponent hero layout", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false, "unicode", false, "titanium", "light");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders the tip inside the box, above the bottom border, not as a dangling line below it", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const welcome = new WelcomeComponent("1.2.3", "claude-sonnet-4-5", "anthropic");
		const frame = plain(welcome.render(80));

		const tipIdx = frame.indexOf("Tip:");
		const bottomBorderIdx = frame.lastIndexOf("└");
		expect(tipIdx).toBeGreaterThan(0);
		expect(bottomBorderIdx).toBeGreaterThan(tipIdx);
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

	it("fits the startup card in the compact height budget at every width", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const sessions = [
			{ name: "fix-the-parser", timeAgo: "2h ago" },
			{ name: "theme-work", timeAgo: "1d ago" },
			{ name: "release-prep", timeAgo: "3d ago" },
		];
		for (const width of [40, 60, 80, 120, 200]) {
			const welcome = new WelcomeComponent("1.2.3", "claude-sonnet-4-5", "anthropic", sessions);
			const lines = welcome.render(width);
			expect(lines.length).toBeLessThanOrEqual(WELCOME_COMPACT_MAX_ROWS);
		}
	});

	it("marks a clipped compact tip with an ellipsis instead of cutting mid-sentence", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		// At width 40 the tip budget is ~28 columns and the shortest shipped tip is
		// 35 chars, so every tip wraps; compact shows only the first line and must
		// flag the cut.
		const welcome = new WelcomeComponent("1.2.3", "gpt-5", "openai");
		const tipLine = welcome
			.render(40)
			.map(line => stripVTControlCharacters(line))
			.find(line => line.includes("Tip: "));
		if (tipLine === undefined) throw new Error("Expected a Tip: line on the compact card");
		const content = tipLine.replace(/[│┌┐└┘]/g, "").trimEnd();
		expect(content.endsWith("…")).toBe(true);
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

	it("points the compact card at /welcome, and the full card carries the menu and recents", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const sessions = [{ name: "fix-the-parser", timeAgo: "2h ago" }];

		const compact = plain(new WelcomeComponent("1.2.3", "gpt-5", "openai", sessions).render(80));
		expect(compact).toContain("/welcome");
		expect(compact).not.toContain("Resume session");
		expect(compact).not.toContain("fix-the-parser");

		const full = new WelcomeComponent("1.2.3", "gpt-5", "openai", sessions, [], true);
		const fullFrame = plain(full.render(80));
		expect(fullFrame).toContain("Resume session");
		expect(fullFrame).toContain("Settings");
		expect(fullFrame).toContain("fix-the-parser");
		expect(full.render(80).length).toBeGreaterThan(WELCOME_COMPACT_MAX_ROWS);
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
