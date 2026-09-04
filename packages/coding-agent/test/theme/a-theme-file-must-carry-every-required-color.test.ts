/**
 * A theme file that omits a color token, or gives one a value that is not a color, is reported —
 * for every token, not for the one someone had in mind.
 *
 * WHY THIS SUITE EXISTS. The theme reader used to validate against a schema library built at module
 * scope, which cost 362ms on every launch to check a file most sessions never have. The validator is
 * now hand-rolled (`validateThemeJson`), and a hand-rolled validator is where a required-token check
 * quietly stops being required: dropping the `undefined` test, or letting `isColorValue` answer true
 * for anything, leaves a broken theme loading and rendering with `undefined` where a color goes. Both
 * mutations survived the rest of the theme suite.
 *
 * The class this closes is "a token the validator forgot". The variant space is enumerated from the
 * exported token lists at run time, which are themselves derived from the `ThemeColor` and `ThemeBg`
 * records, so a token added to either union is swept here without anyone editing this file, and a
 * token that stops being checked turns the sweep red. The bundled themes cross-check the derivation
 * itself, since a sweep that reads the validator's own list cannot see that list shrink.
 *
 * What it does not catch: whether a color STRING is a color veyyon can render. `isColorValue` accepts
 * any string, because a theme names palette vars as well as hex literals and the resolver decides;
 * `ground-tints.test.ts` and `accent-tokens.test.ts` cover resolution. It also says nothing about the
 * file ever reaching the reader from disk — `broken-theme-is-reported.test.ts` states why that cannot
 * be exercised in-process.
 */

import { describe, expect, it } from "bun:test";
import { getBuiltinThemes } from "@veyyon/coding-agent/theme/builtin-themes";
import {
	OPTIONAL_THEME_COLOR_TOKENS,
	REQUIRED_THEME_COLOR_TOKENS,
	validateThemeJson,
} from "@veyyon/coding-agent/theme/color";

/** A theme file with every required token present, built from the list the validator reads. */
function completeTheme(): Record<string, unknown> {
	const colors: Record<string, unknown> = {};
	for (const token of REQUIRED_THEME_COLOR_TOKENS) {
		colors[token] = "#101010";
	}
	return { name: "sweep", colors };
}

/** Values a color token may never hold. A number is a valid color value and is not in this list. */
const NOT_A_COLOR = [true, null, {}, [], () => {}] as const;

describe("the token lists the sweep runs over", () => {
	/**
	 * A sweep over an empty list passes without asserting anything, so the harness states its own
	 * size. The exact count is not pinned — a new token is meant to join without editing this file —
	 * but a list that collapsed to nothing, or an optional token that is also required, is a hole.
	 */
	it("is non-empty and disjoint", () => {
		expect(REQUIRED_THEME_COLOR_TOKENS.length).toBeGreaterThan(40);
		const optional = new Set<string>(OPTIONAL_THEME_COLOR_TOKENS);
		expect(REQUIRED_THEME_COLOR_TOKENS.filter(token => optional.has(token))).toEqual([]);
	});

	/**
	 * The sweep reads the same list the validator reads, so a derivation that dropped half a union
	 * would shrink both together and stay green. The bundled themes are the independent source: they
	 * declare every token the product renders, so a token they carry that neither list knows about is
	 * a token nothing validates.
	 */
	it("covers every color token the bundled themes declare", () => {
		const known = new Set<string>([...REQUIRED_THEME_COLOR_TOKENS, ...OPTIONAL_THEME_COLOR_TOKENS]);
		const unvalidated = new Set<string>();
		for (const theme of Object.values(getBuiltinThemes())) {
			for (const token of Object.keys(theme.colors)) {
				if (!known.has(token)) {
					unvalidated.add(token);
				}
			}
		}
		expect([...unvalidated]).toEqual([]);
	});
});

describe("a complete theme file", () => {
	it("reports nothing", () => {
		expect(validateThemeJson(completeTheme())).toEqual({ missingColors: [], problems: [] });
	});

	it("accepts a numeric color value", () => {
		const theme = completeTheme();
		(theme.colors as Record<string, unknown>).accent = 0xff8800;
		expect(validateThemeJson(theme)).toEqual({ missingColors: [], problems: [] });
	});

	it("accepts a token this build has never heard of", () => {
		const theme = completeTheme();
		(theme.colors as Record<string, unknown>).aTokenFromALaterBuild = "#ffffff";
		expect(validateThemeJson(theme)).toEqual({ missingColors: [], problems: [] });
	});
});

describe("every required color token", () => {
	for (const token of REQUIRED_THEME_COLOR_TOKENS) {
		/** Absent: named in `missingColors`, and named alone, so the reader can list what to add. */
		it(`is reported as missing when "${token}" is absent`, () => {
			const theme = completeTheme();
			delete (theme.colors as Record<string, unknown>)[token];
			expect(validateThemeJson(theme)).toEqual({ missingColors: [token], problems: [] });
		});

		/** Present but not a color: a problem, not a missing token, and it names the token. */
		it(`is reported as a problem when "${token}" is not a color`, () => {
			const theme = completeTheme();
			(theme.colors as Record<string, unknown>)[token] = true;
			expect(validateThemeJson(theme)).toEqual({
				missingColors: [],
				problems: [`"colors.${token}" must be a string or a number`],
			});
		});
	}
});

describe("every optional color token", () => {
	for (const token of OPTIONAL_THEME_COLOR_TOKENS) {
		it(`passes when "${token}" is absent`, () => {
			const theme = completeTheme();
			delete (theme.colors as Record<string, unknown>)[token];
			expect(validateThemeJson(theme)).toEqual({ missingColors: [], problems: [] });
		});

		it(`is reported when "${token}" is present and not a color`, () => {
			const theme = completeTheme();
			(theme.colors as Record<string, unknown>)[token] = [];
			expect(validateThemeJson(theme).problems).toContain(`"colors.${token}" must be a string or a number`);
		});
	}
});

describe("a value that is not a color", () => {
	for (const value of NOT_A_COLOR) {
		it(`is refused as ${typeof value === "object" ? JSON.stringify(value) : String(value)}`, () => {
			const theme = completeTheme();
			(theme.colors as Record<string, unknown>).text = value;
			expect(validateThemeJson(theme).problems).toEqual(['"colors.text" must be a string or a number']);
		});
	}
});

describe("a file that is not a theme", () => {
	it("reports the shape, not seventy missing tokens", () => {
		expect(validateThemeJson("dark")).toEqual({ missingColors: [], problems: ["the file is not a JSON object"] });
	});

	it("reports a missing colors object once", () => {
		expect(validateThemeJson({ name: "sweep" })).toEqual({
			missingColors: [],
			problems: ['"colors" must be an object'],
		});
	});

	it("reports a missing name alongside the colors it does carry", () => {
		const theme = completeTheme();
		delete theme.name;
		expect(validateThemeJson(theme)).toEqual({ missingColors: [], problems: ['"name" must be a string'] });
	});
});

describe("the rest of the file", () => {
	it("refuses a non-color palette var", () => {
		expect(validateThemeJson({ ...completeTheme(), vars: { base: false } }).problems).toEqual([
			'"vars" must map each name to a string or a number',
		]);
	});

	it("refuses an export ground that is not a color", () => {
		expect(validateThemeJson({ ...completeTheme(), export: { cardBg: {} } }).problems).toEqual([
			'"export.cardBg" must be a string or a number',
		]);
	});

	it("refuses a symbol preset it cannot render", () => {
		expect(validateThemeJson({ ...completeTheme(), symbols: { preset: "emoji" } }).problems).toEqual([
			'"symbols.preset" must be "unicode", "nerd" or "ascii"',
		]);
	});

	it("refuses an empty spinner frame list", () => {
		expect(validateThemeJson({ ...completeTheme(), symbols: { spinnerFrames: [] } }).problems).toHaveLength(1);
	});

	it("accepts a spinner override that names one lane", () => {
		expect(validateThemeJson({ ...completeTheme(), symbols: { spinnerFrames: { thinking: ["·", ":"] } } })).toEqual({
			missingColors: [],
			problems: [],
		});
	});
});
