import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DEFAULT_PROFILE_DIR_NAME, getActiveProfileOrDefault, setProfile } from "@veyyon/utils";
import { ASCII_SYMBOLS, NERD_SYMBOLS, UNICODE_SYMBOLS } from "../../theme/symbols";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { STATUS_LINE_PRESETS } from "./presets";
import { renderSegment, SEGMENTS } from "./segments";
import type { SegmentContext } from "./types";

// The `profile` status-line segment is the only visual indicator of which veyyon
// profile ("work", "rec", a client sandbox) is live. Before it existed there was
// no way to tell from the TUI which config, sessions, and keys were in play, so a
// command could silently hit the wrong sandbox. These tests lock the contract:
// a named profile is always shown, the built-in "default" stays hidden so the
// decluttered vanilla status line is unchanged, the icon is wired per symbol
// preset, and every preset actually carries the segment.

// The segment ignores its context; a bare object satisfies the signature.
const CTX = {} as SegmentContext;

beforeAll(async () => {
	// A real theme so `theme.icon.profile` resolves (unicode preset → blank icon).
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

afterEach(() => {
	// Every test that activates a profile must return to the default so the shared
	// process-global `activeProfile` cannot leak into the next test.
	setProfile(undefined);
});

describe("status-line profile segment", () => {
	it("hides on the built-in default profile so the vanilla status line is unchanged", () => {
		setProfile(undefined);
		expect(getActiveProfileOrDefault()).toBe(DEFAULT_PROFILE_DIR_NAME);

		const rendered = renderSegment("profile", CTX);
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});

	it("shows the active profile name for a named sandbox", () => {
		setProfile("work");

		const rendered = renderSegment("profile", CTX);
		expect(rendered.visible).toBe(true);
		// Unicode preset blanks the icon, so the content is exactly the profile name.
		expect(rendered.content).toBe("work");
	});

	it("renders each named profile verbatim, not a hardcoded label", () => {
		for (const name of ["rec", "bench-profile", "client-acme"]) {
			setProfile(name);
			const rendered = renderSegment("profile", CTX);
			expect(rendered.visible).toBe(true);
			expect(rendered.content).toBe(name);
		}
	});

	it("dispatches through the SEGMENTS registry under the `profile` id", () => {
		// Proves the segment is wired into the registry, not merely defined.
		expect(SEGMENTS.profile).toBeDefined();
		expect(SEGMENTS.profile?.id).toBe("profile");
	});

	it("carries a distinct icon per symbol preset", () => {
		// Locks the three symbol records so a re-vendor or edit cannot drop one.
		expect(UNICODE_SYMBOLS["icon.profile"]).toBe("");
		expect(NERD_SYMBOLS["icon.profile"]).toBe("\uf007");
		expect(ASCII_SYMBOLS["icon.profile"]).toBe("prof");
	});

	it("is present in every built-in preset's left segments", () => {
		// The indicator only helps if a preset actually places it; assert none drops it.
		for (const [name, preset] of Object.entries(STATUS_LINE_PRESETS)) {
			expect(preset.leftSegments, `preset ${name} must include profile`).toContain("profile");
		}
		// The decluttered default leads with it so a named sandbox reads first.
		expect(STATUS_LINE_PRESETS.default.leftSegments[0]).toBe("profile");
	});
});
