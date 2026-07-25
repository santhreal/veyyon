import { beforeAll, describe, expect, it } from "bun:test";
import {
	buildUpdateHint,
	renderUpdateHint,
	styleUpdateHint,
	WelcomeComponent,
} from "@veyyon/coding-agent/modes/components/welcome";
import { initTheme, setTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { visibleWidth } from "@veyyon/tui";

/**
 * The post-update hint takes the welcome tip slot on the first launch after an
 * upgrade, replacing the old transcript-block notice. It exists to make the
 * three things a user needs after an update discoverable: what changed
 * (`/changelog`), and where to roll back or pause auto-updates (`/settings`).
 * These tests lock that the wording carries all three, that the slash commands
 * paint in the accent (the whole point of moving it out of muted tip text), and
 * that the component actually swaps the hint in for the random tip.
 */
describe("buildUpdateHint", () => {
	it("names the version and points at /changelog, /rollback and /settings", () => {
		// The single source of the wording — every surface reads it from here, so a
		// dropped affordance here drops it everywhere. All three post-update
		// affordances must be present: what changed, how to undo, how to pause.
		const hint = buildUpdateHint("1.0.12");
		expect(hint).toContain("v1.0.12");
		expect(hint).toContain("/changelog");
		expect(hint).toContain("/rollback");
		expect(hint).toContain("/settings");
		expect(hint.toLowerCase()).toContain("auto-update");
	});

	it("normalizes a leading v so the version reads once, not twice", () => {
		// installedVersion arrives bare (1.0.12) but a tag-shaped value must not
		// render `vv1.0.12`.
		expect(buildUpdateHint("v1.0.12")).toContain("v1.0.12");
		expect(buildUpdateHint("v1.0.12")).not.toContain("vv1.0.12");
	});
});

describe("renderUpdateHint", () => {
	beforeAll(async () => {
		await initTheme(false);
		setTheme("titanium");
	});

	it("paints every slash command in the accent, not muted body", () => {
		// Moving the notice into the tip slot only helps discoverability if the
		// commands stand out. Assert the accent escape wraps each command token.
		const lines = renderUpdateHint("1.0.12", 100);
		const joined = lines.join("");
		expect(joined).toContain(theme.fg("accent", "/changelog"));
		expect(joined).toContain(theme.fg("accent", "/rollback"));
		expect(joined).toContain(theme.fg("accent", "/settings"));
	});

	it("wraps within the box width without truncation", () => {
		// The hint is longer than a narrow home card; it must wrap, never ellipsize.
		const width = 40;
		const lines = renderUpdateHint("1.0.12", width);
		const plain = lines.map(line => Bun.stripANSI(line));
		expect(plain.length).toBeGreaterThan(1);
		expect(plain.join(" ")).not.toContain("…");
		for (const line of plain) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("returns nothing when the slot is too narrow to be legible", () => {
		// Below the minimum body budget the tip renderer yields no lines rather
		// than a broken single glyph; the hint follows the same contract.
		expect(renderUpdateHint("1.0.12", 6)).toEqual([]);
	});
});

describe("styleUpdateHint (shared by the tip slot and the transcript fallback)", () => {
	beforeAll(async () => {
		await initTheme(false);
		setTheme("titanium");
	});

	/**
	 * The bug this locks out: the transcript fallback (shown when there is no
	 * welcome component to host the tip slot) hardcoded its own older wording that
	 * only mentioned `/changelog`, so the two post-update surfaces disagreed. Both
	 * now render `styleUpdateHint`, so its plain text must carry the full wording
	 * (`buildUpdateHint`) verbatim — one owner, no drift.
	 */
	it("carries the exact buildUpdateHint wording as its plain text", () => {
		const plain = Bun.stripANSI(styleUpdateHint("1.0.12"));
		expect(plain).toBe(buildUpdateHint("1.0.12"));
	});

	it("bolds and accents all three slash commands so the fallback pops too", () => {
		const styled = styleUpdateHint("1.0.12");
		expect(styled).toContain(theme.bold(theme.fg("accent", "/changelog")));
		expect(styled).toContain(theme.bold(theme.fg("accent", "/rollback")));
		expect(styled).toContain(theme.bold(theme.fg("accent", "/settings")));
	});
});

describe("WelcomeComponent update hint", () => {
	beforeAll(async () => {
		await initTheme(false);
		setTheme("titanium");
	});

	it("renders the update hint in place of a random tip once set", () => {
		// setUpdateHint is the one-shot post-update override; after it's called the
		// welcome's tip slot must show the hint (with its accent commands), proving
		// the wiring from the update decision to the tip slot end to end.
		const welcome = new WelcomeComponent("1.0.12", "model", "provider");
		welcome.setUpdateHint("1.0.12");
		const frame = welcome.render(80).join("\n");
		const plain = Bun.stripANSI(frame);
		expect(plain).toContain("Updated to veyyon v1.0.12");
		expect(plain).toContain("/changelog");
		expect(plain).toContain("/settings");
		// The accent-painted command proves it rendered through renderUpdateHint,
		// not as a muted ordinary tip.
		expect(frame).toContain(theme.fg("accent", "/changelog"));
	});

	it("does not show the hint before it is set", () => {
		// A normal launch (no update) must never surface the hint text.
		const welcome = new WelcomeComponent("1.0.12", "model", "provider");
		const plain = Bun.stripANSI(welcome.render(80).join("\n"));
		expect(plain).not.toContain("Updated to veyyon");
	});
});
