import { beforeAll, describe, expect, it } from "bun:test";
import { renderWelcomeTip } from "@veyyon/coding-agent/modes/components/welcome";
import { initTheme, setTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { visibleWidth } from "@veyyon/tui";

describe("renderWelcomeTip", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("wraps long tips under the label instead of truncating", () => {
		const tip = "Next time you see spaghetti try creating a TTSR rule that prevents this pattern before it spreads";
		const width = 44;
		const lines = renderWelcomeTip(tip, width);
		const plain = lines.map(line => Bun.stripANSI(line));

		expect(plain.length).toBeGreaterThan(1);
		expect(plain.join(" ")).not.toContain("…");
		expect(plain[0]).toStartWith(" Tip: Next time");
		expect(plain[1]).toStartWith("      ");
		for (const line of plain) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("replaces a trailing [NEW] marker with a quiet silver 'new' tag", () => {
		const lines = renderWelcomeTip("Try the shiny advisor [NEW]", 60);
		const plain = lines.map(line => Bun.stripANSI(line)).join("\n");
		const styled = lines.join("\n");

		expect(plain).toContain("Try the shiny advisor");
		expect(plain).not.toContain("[NEW]");
		expect(plain).toContain("new");
		expect(plain).not.toContain("NEW!");
		expect(styled).toContain("\x1b[1m");
		expect(styled).not.toBe(plain);
	});

	it("keeps the new tag within the box width", () => {
		for (const width of [24, 40, 60]) {
			const lines = renderWelcomeTip("Turn on the advisor to review every turn [NEW]", width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			expect(lines.map(l => Bun.stripANSI(l)).join("\n")).toContain("new");
		}
	});

	it("keeps the tag static across phases (no rainbow shimmer)", () => {
		const tip = "Fresh feature here [NEW]";
		const still = renderWelcomeTip(tip, 60, 0);
		const shifted = renderWelcomeTip(tip, 60, 0.5);

		expect(shifted.join("\n")).toBe(still.join("\n"));
		expect(shifted.map(l => Bun.stripANSI(l))).toEqual(still.map(l => Bun.stripANSI(l)));
	});

	it("leaves tips without the marker untouched", () => {
		const lines = renderWelcomeTip("Plain old tip", 60);
		const plain = lines.map(line => Bun.stripANSI(line)).join("\n");
		expect(plain).not.toContain("NEW!");
		expect(plain).toContain("Tip: Plain old tip");
	});

	it("derives label and body colors from the active theme, with no manual dim layer", async () => {
		await setTheme("dark");
		const darkLabelAnsi = theme.getFgAnsi("customMessageLabel");
		const darkMutedAnsi = theme.getFgAnsi("muted");
		const dark = renderWelcomeTip("Welcome aboard friend", 60).join("\n");

		await setTheme("light");
		const lightLabelAnsi = theme.getFgAnsi("customMessageLabel");
		const lightMutedAnsi = theme.getFgAnsi("muted");
		const light = renderWelcomeTip("Welcome aboard friend", 60).join("\n");

		expect(dark).toContain(darkLabelAnsi);
		expect(dark).toContain(darkMutedAnsi);
		expect(light).toContain(lightLabelAnsi);
		expect(light).toContain(lightMutedAnsi);
		expect(dark).not.toBe(light);
		expect(dark).not.toContain("\x1b[2m");
		expect(light).not.toContain("\x1b[2m");
	});
});
