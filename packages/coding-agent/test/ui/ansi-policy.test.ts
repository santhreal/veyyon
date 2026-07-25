/**
 * `NO_COLOR`, `TERM=dumb`, and who decides whether escapes are emitted.
 *
 * The theme emitted full truecolor SGR regardless of the environment. `NO_COLOR`
 * (no-color.org) was read in exactly one place in the whole product — the
 * hyperlink check — and the theme, which paints every single character on
 * screen, ignored it completely. Piping veyyon's output anywhere that cannot
 * interpret escapes produced literal `[38;2;198;203;212m` garbage, and a user
 * who sets `NO_COLOR` because their terminal renders the palette unreadably had
 * no way to turn it off.
 *
 * The policy has three states rather than two, and the distinction is the
 * interesting part:
 *
 *   - `NO_COLOR` asks for COLOUR to be dropped. Bold and italic still carry
 *     emphasis, and dropping them too would lose structure the user did not ask
 *     to lose.
 *   - `TERM=dumb` is a terminal that cannot interpret escape sequences at all,
 *     so every one of them becomes visible garbage. Nothing is emitted.
 *   - `FORCE_COLOR` wins over both, which is how a CI runner that pipes output
 *     but still renders colour gets it.
 *
 * These tests hold the detection rules and the theme's use of them, including
 * the one thing that must NOT become conditional: an unknown colour key still
 * throws when colour is off, or the bug would only surface on machines that
 * render it.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { detectAnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "titanium");
});

afterEach(() => {
	setAnsiPolicy(detectAnsiPolicy());
});

const hasEscape = (text: string) => text.includes("\x1b[");

describe("detectAnsiPolicy", () => {
	it("returns full for an ordinary terminal", () => {
		expect(detectAnsiPolicy({ TERM: "xterm-256color" })).toBe("full");
	});

	it("drops colour when NO_COLOR is set to anything non-empty", () => {
		expect(detectAnsiPolicy({ NO_COLOR: "1" })).toBe("noColor");
		expect(detectAnsiPolicy({ NO_COLOR: "yes" })).toBe("noColor");
	});

	it("ignores an EMPTY NO_COLOR, as the convention requires", () => {
		// The spec is explicit that `NO_COLOR=` must not disable anything, and an
		// empty value is what a shell leaves behind when a variable is cleared
		// rather than unset.
		expect(detectAnsiPolicy({ NO_COLOR: "" })).toBe("full");
	});

	it("drops every escape for a dumb terminal", () => {
		expect(detectAnsiPolicy({ TERM: "dumb" })).toBe("plain");
		expect(detectAnsiPolicy({ TERM: "DUMB" })).toBe("plain");
	});

	it("lets FORCE_COLOR override both", () => {
		expect(detectAnsiPolicy({ NO_COLOR: "1", FORCE_COLOR: "1" })).toBe("full");
		expect(detectAnsiPolicy({ TERM: "dumb", FORCE_COLOR: "3" })).toBe("full");
	});

	it("treats FORCE_COLOR=0 as not forcing", () => {
		// `FORCE_COLOR=0` is the conventional way to say "no", and reading it as
		// "force" would invert the user's intent.
		expect(detectAnsiPolicy({ NO_COLOR: "1", FORCE_COLOR: "0" })).toBe("noColor");
		expect(detectAnsiPolicy({ NO_COLOR: "1", FORCE_COLOR: "" })).toBe("noColor");
	});
});

describe("the theme under noColor", () => {
	it("emits the text with no escapes at all for a colour", () => {
		setAnsiPolicy("noColor");

		expect(theme.fg("accent", "hello")).toBe("hello");
		expect(theme.bg("selectedBg", "hello")).toBe("hello");
	});

	it("keeps bold and italic, which are not colour", () => {
		// The point of the three-state policy. A user turning colour off has not
		// asked to lose every visual distinction in the output.
		setAnsiPolicy("noColor");

		expect(theme.bold("hello")).toBe("\x1b[1mhello\x1b[22m");
		expect(theme.italic("hello")).toBe("\x1b[3mhello\x1b[23m");
	});

	it("still throws on an unknown colour key", () => {
		// This must NOT become conditional on the policy: a typo that only fails
		// on colour-capable machines is worse than one that always fails.
		setAnsiPolicy("noColor");

		expect(() => theme.fg("nope" as never, "hello")).toThrow(/Unknown theme color/);
	});
});

describe("the theme under plain", () => {
	it("emits no escape sequence of any kind", () => {
		setAnsiPolicy("plain");

		for (const styled of [
			theme.fg("accent", "hello"),
			theme.bg("selectedBg", "hello"),
			theme.bold("hello"),
			theme.italic("hello"),
			theme.underline("hello"),
			theme.strikethrough("hello"),
			theme.inverse("hello"),
		]) {
			expect(styled).toBe("hello");
			expect(hasEscape(styled)).toBe(false);
		}
	});
});

describe("the theme under full", () => {
	it("paints colour and attributes, so the fix costs the normal case nothing", () => {
		setAnsiPolicy("full");

		expect(hasEscape(theme.fg("accent", "hello"))).toBe(true);
		expect(theme.bold("hello")).toBe("\x1b[1mhello\x1b[22m");
	});
});

describe("the policy owner", () => {
	it("is what everything reads, so no surface can disagree", () => {
		// The defect being prevented: `NO_COLOR` had one reader (hyperlinks) and
		// the theme had none. Two independent detectors drift.
		setAnsiPolicy("plain");

		expect(getAnsiPolicy()).toBe("plain");
		expect(theme.fg("accent", "x")).toBe("x");
	});
});
