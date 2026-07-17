import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings, settings } from "@veyyon/pi-coding-agent/config/settings";
import { pickWeightedTip, WelcomeComponent } from "@veyyon/pi-coding-agent/modes/components/welcome";
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

	it("frames the home with open space — no box borders anywhere, at any width", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		for (const width of [40, 60, 80, 120, 200]) {
			const frame = plain(new WelcomeComponent("1.2.3", "gpt-5", "openai").render(width));
			expect(frame).not.toMatch(/[┌┐└┘│]/);
		}
	});

	it("renders the sun over the letterspaced wordmark over one metadata line", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const lines = new WelcomeComponent("1.2.3", "gpt-5", "openai")
			.render(120)
			.map(line => stripVTControlCharacters(line));

		const sunIdx = lines.findIndex(line => /[░▒▓]/.test(line));
		const wordIdx = lines.findIndex(line => line.includes("v e y y o n"));
		const metaIdx = lines.findIndex(
			line => line.includes("v1.2.3") && line.includes("gpt-5") && line.includes("openai"),
		);
		const valueIdx = lines.findIndex(line => line.includes("Hashline edits that land"));
		expect(sunIdx).toBeGreaterThanOrEqual(0);
		expect(wordIdx).toBeGreaterThan(sunIdx);
		expect(metaIdx).toBeGreaterThan(wordIdx);
		expect(valueIdx).toBeGreaterThan(metaIdx);
		// One shared metadata slot — neither name repeats on a second row.
		expect(lines.filter(line => line.includes("gpt-5")).length).toBe(1);
		expect(lines.filter(line => line.includes("openai")).length).toBe(1);
	});

	it("keeps the home bounded at every width — the sun never clips", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		for (const width of [40, 60, 80, 120, 200]) {
			const lines = new WelcomeComponent("1.2.3", "gpt-5", "openai").render(width);
			// Sun budget is capped by the terminal rows (test env: the 60-row
			// fallback), plus the fixed header tail (wordmark, meta, value, hint).
			expect(lines.length).toBeLessThanOrEqual(44);
		}
	});

	it("renders a /login call to action instead of a dead 'Unknown' line when no model is set", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const frame = plain(new WelcomeComponent("1.2.3", "", "").render(80));

		expect(frame).toContain("no model yet");
		expect(frame).toContain("/login");
		expect(frame).not.toContain("Unknown");
	});

	it("points the home at /welcome, and the full page carries the menu and recents", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const sessions = [{ name: "fix-the-parser", timeAgo: "2h ago" }];

		const compact = plain(new WelcomeComponent("1.2.3", "gpt-5", "openai", sessions).render(80));
		expect(compact).toContain("/welcome");
		expect(compact).toContain("/resume");
		expect(compact).not.toContain("Resume session");
		expect(compact).not.toContain("fix-the-parser");

		const full = plain(new WelcomeComponent("1.2.3", "gpt-5", "openai", sessions, [], true).render(80));
		expect(full).toContain("Resume session");
		expect(full).toContain("Settings");
		expect(full).toContain("fix-the-parser");
	});

	it("carries the full selected tip on the full page (positive twin)", () => {
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

	it("wraps long tips across lines on the narrow full page instead of clipping them", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.99);
		const welcome = new WelcomeComponent("1.2.3", "gpt-5", "openai", [], [], true);
		const tip = welcome.tip;
		if (!tip) throw new Error("Expected a selected tip");
		const lastWord =
			tip
				.replace(/\s*\[NEW\]$/, "")
				.split(/\s+/)
				.at(-1) ?? "";
		// At width 40 the tip budget is ~30 columns and the shortest shipped tip
		// is 35 chars, so every tip wraps; the wrap must keep the final word.
		expect(plain(welcome.render(40))).toContain(lastWord);
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
