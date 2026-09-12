/**
 * WHY: PresentationTheme is the wire contract snapshot representing a production Theme.
 * This suite guarantees lossless round-trip between native Theme and PresentationTheme,
 * verifies terminal default colors, ANSI 256 colors, text attributes (bold/italic/underline/etc.),
 * symbol presets/overrides, spinner frames, and the live theme lifecycle application path.
 */

import { describe, expect, it } from "bun:test";
import type {
	ColorValue,
	PresentationTheme,
	SpinnerType,
	SymbolKey,
	TextStyle,
	ThemeBg,
	ThemeColor,
} from "@veyyon/wire/presentation";
import { SPINNER_TYPES, THEME_BG_COLORS, THEME_COLORS } from "@veyyon/wire/presentation";
import {
	applyPresentationTheme,
	createTheme,
	createThemeFromPresentationTheme,
	getBuiltinTheme,
	getBuiltinThemeNames,
	onThemeChange,
	theme,
	toPresentationTheme,
} from "../../src/theme/theme";
import { useFullColor } from "../helpers/theme-assertions";

describe("Theme <-> PresentationTheme canonical snapshot round-trip", () => {
	useFullColor();

	it("round-trips all built-in themes losslessly", () => {
		const builtinNames = getBuiltinThemeNames();
		expect(builtinNames.length).toBeGreaterThan(0);

		for (const name of builtinNames) {
			const json = getBuiltinTheme(name)!;
			const original = createTheme(json);
			const snapshot = toPresentationTheme(original, name, name);

			expect(snapshot.id).toBe(name);
			expect(snapshot.name).toBe(name);
			expect(snapshot.appearance).toBe(original.isLight ? "light" : "dark");

			const restored = createThemeFromPresentationTheme(snapshot, { mode: original.getColorMode() });

			// Verify every foreground color matches
			for (const color of THEME_COLORS) {
				expect(restored.getColorHex(color)).toBe(original.getColorHex(color));
				expect(restored.getFgAnsi(color)).toBe(original.getFgAnsi(color));
			}

			// Verify every background color matches
			for (const bg of THEME_BG_COLORS) {
				expect(restored.getBgColorHex(bg)).toBe(original.getBgColorHex(bg));
				expect(restored.getBgAnsi(bg)).toBe(original.getBgAnsi(bg));
			}

			// Verify appearance and ground
			expect(restored.isLight).toBe(original.isLight);
			expect(restored.getGroundHex()).toBe(original.getGroundHex());
			expect(restored.getSymbolPreset()).toBe(original.getSymbolPreset());

			// Verify spinners
			for (const spinner of SPINNER_TYPES) {
				expect(restored.getSpinnerFrames(spinner)).toEqual(original.getSpinnerFrames(spinner));
			}
		}
	});

	it("preserves terminal defaults ('') without failing", () => {
		const snapshot: PresentationTheme = {
			id: "default-colors-test",
			name: "Default Colors Test",
			appearance: "dark",
			colors: Object.fromEntries(THEME_COLORS.map(k => [k, ""])) as Record<ThemeColor, ColorValue>,
			backgrounds: Object.fromEntries(THEME_BG_COLORS.map(k => [k, ""])) as Record<ThemeBg, ColorValue>,
			symbolPreset: "unicode",
		};

		const instance = createThemeFromPresentationTheme(snapshot, { mode: "truecolor" });
		expect(instance.getFgAnsi("text")).toBe("\x1b[39m");
		expect(instance.getBgAnsi("composerBg")).toBe("\x1b[49m");

		// Round-trip back to snapshot
		const reshot = instance.toPresentationTheme("Default Colors Test", "default-colors-test");
		expect(reshot.colors.text).toBe("");
		expect(reshot.backgrounds.composerBg).toBe("");
	});

	it("preserves ANSI 256 numeric colors and hex colors", () => {
		const snapshot: PresentationTheme = {
			id: "ansi256-test",
			name: "ANSI 256 Test",
			appearance: "dark",
			colors: {
				...Object.fromEntries(THEME_COLORS.map(k => [k, "#112233"])),
				accent: 208,
				success: "#00ff88",
			} as Record<ThemeColor, ColorValue>,
			backgrounds: {
				...Object.fromEntries(THEME_BG_COLORS.map(k => [k, "#001122"])),
				statusLineBg: 236,
			} as Record<ThemeBg, ColorValue>,
			symbolPreset: "ascii",
		};

		const instance = createThemeFromPresentationTheme(snapshot, { mode: "256color" });
		expect(instance.getFgAnsi("accent")).toBe("\x1b[38;5;208m");
		expect(instance.getBgAnsi("statusLineBg")).toBe("\x1b[48;5;236m");

		const reshot = instance.toPresentationTheme("ANSI 256 Test", "ansi256-test");
		expect(reshot.colors.accent).toBe(208);
		expect(reshot.backgrounds.statusLineBg).toBe(236);
		expect(reshot.colors.success).toBe("#00ff88");
	});

	it("preserves and applies text attributes on roles", () => {
		const styles: Partial<Record<ThemeColor, TextStyle>> = {
			accent: { underline: true, bold: true },
			warning: { italic: true },
			error: { strikethrough: true, inverse: true },
		};

		const snapshot: PresentationTheme = {
			id: "styles-test",
			name: "Styles Test",
			appearance: "dark",
			colors: {
				...Object.fromEntries(THEME_COLORS.map(k => [k, "#888888"])),
				accent: "#00aaff",
			} as Record<ThemeColor, ColorValue>,
			backgrounds: Object.fromEntries(THEME_BG_COLORS.map(k => [k, "#111111"])) as Record<ThemeBg, ColorValue>,
			symbolPreset: "unicode",
			styles,
		};

		const instance = createThemeFromPresentationTheme(snapshot, { mode: "truecolor" });
		const styledAccent = instance.fg("accent", "thinking");
		expect(styledAccent).toContain("\x1b[1m"); // bold open
		expect(styledAccent).toContain("\x1b[4m"); // underline open
		expect(styledAccent).toContain("\x1b[22m"); // bold off
		expect(styledAccent).toContain("\x1b[24m"); // underline off
		expect(styledAccent).toContain("thinking");

		const reshot = instance.toPresentationTheme("Styles Test", "styles-test");
		expect(reshot.styles?.accent).toEqual({ underline: true, bold: true });
		expect(reshot.styles?.warning).toEqual({ italic: true });
		expect(reshot.styles?.error).toEqual({ strikethrough: true, inverse: true });
	});

	it("preserves symbol presets, symbol overrides and custom spinner frames", () => {
		const symbolOverrides: Partial<Record<SymbolKey, string>> = {
			"icon.model": "󰚩",
			"status.success": "✓!",
		};
		const spinnerFrames: Partial<Record<SpinnerType, string[]>> = {
			status: ["1", "2", "3", "4"],
			thinking: ["a", "b"],
		};

		const snapshot: PresentationTheme = {
			id: "symbols-test",
			name: "Symbols Test",
			appearance: "dark",
			colors: Object.fromEntries(THEME_COLORS.map(k => [k, "#555555"])) as Record<ThemeColor, ColorValue>,
			backgrounds: Object.fromEntries(THEME_BG_COLORS.map(k => [k, "#000000"])) as Record<ThemeBg, ColorValue>,
			symbolPreset: "nerd",
			symbolOverrides,
			spinnerFrames,
			groundHex: "#0a0a0f",
		};

		const instance = createThemeFromPresentationTheme(snapshot, { mode: "truecolor" });
		expect(instance.getSymbolPreset()).toBe("nerd");
		expect(instance.symbol("icon.model")).toBe("󰚩");
		expect(instance.symbol("status.success")).toBe("✓!");
		expect(instance.getSpinnerFrames("status")).toEqual(["1", "2", "3", "4"]);
		expect(instance.getSpinnerFrames("thinking")).toEqual(["a", "b"]);
		expect(instance.getGroundHex()).toBe("#0a0a0f");

		const reshot = instance.toPresentationTheme("Symbols Test", "symbols-test");
		expect(reshot.symbolPreset).toBe("nerd");
		expect(reshot.symbolOverrides?.["icon.model"]).toBe("󰚩");
		expect(reshot.spinnerFrames?.status).toEqual(["1", "2", "3", "4"]);
		expect(reshot.groundHex).toBe("#0a0a0f");
	});

	it("rejects invalid, incomplete, or inconsistent snapshots before applying", () => {
		// Missing required colors
		expect(() =>
			createThemeFromPresentationTheme({
				id: "bad",
				name: "Bad",
				appearance: "dark",
				colors: {} as never,
				backgrounds: Object.fromEntries(THEME_BG_COLORS.map(k => [k, "#000"])) as never,
				symbolPreset: "unicode",
			}),
		).toThrow("missing required color");

		// Appearance mismatch
		expect(() =>
			createThemeFromPresentationTheme({
				id: "mismatch",
				name: "Mismatch",
				appearance: "light",
				colors: Object.fromEntries(THEME_COLORS.map(k => [k, "#fff"])) as never,
				backgrounds: Object.fromEntries(THEME_BG_COLORS.map(k => [k, "#000000"])) as never, // dark background
				symbolPreset: "unicode",
			}),
		).toThrow("appearance mismatch");

		// Invalid symbol preset
		expect(() =>
			createThemeFromPresentationTheme({
				id: "bad-preset",
				name: "Bad Preset",
				appearance: "dark",
				colors: Object.fromEntries(THEME_COLORS.map(k => [k, "#fff"])) as never,
				backgrounds: Object.fromEntries(THEME_BG_COLORS.map(k => [k, "#000"])) as never,
				symbolPreset: "invalid" as never,
			}),
		).toThrow("symbolPreset");

		// Invalid style attribute
		expect(() =>
			createThemeFromPresentationTheme({
				id: "bad-style",
				name: "Bad Style",
				appearance: "dark",
				colors: Object.fromEntries(THEME_COLORS.map(k => [k, "#fff"])) as never,
				backgrounds: Object.fromEntries(THEME_BG_COLORS.map(k => [k, "#000"])) as never,
				symbolPreset: "unicode",
				styles: { accent: { invalidAttr: true } as never },
			}),
		).toThrow("Invalid style attribute");

		// Invalid color value (not a string or number)
		expect(() =>
			createThemeFromPresentationTheme({
				id: "bad-color",
				name: "Bad Color",
				appearance: "dark",
				colors: {
					...Object.fromEntries(THEME_COLORS.map(k => [k, "#fff"])),
					accent: null as never,
				} as never,
				backgrounds: Object.fromEntries(THEME_BG_COLORS.map(k => [k, "#000"])) as never,
				symbolPreset: "unicode",
			}),
		).toThrow('PresentationTheme "colors.accent" must be a string or number');
	});

	it("leaves current theme unchanged when applying a malformed snapshot", () => {
		const initialTheme = theme;
		let changeEventReceived = false;
		const unsubscribe = onThemeChange(() => {
			changeEventReceived = true;
		});

		try {
			expect(() =>
				applyPresentationTheme({
					id: "malformed",
					name: "Malformed",
					appearance: "dark",
					colors: {} as never,
					backgrounds: Object.fromEntries(THEME_BG_COLORS.map(k => [k, "#000"])) as never,
					symbolPreset: "unicode",
				}),
			).toThrow("missing required color");

			expect(theme).toBe(initialTheme);
			expect(changeEventReceived).toBe(false);
		} finally {
			unsubscribe();
		}
	});

	it("applies theme snapshots to the host-wide theme lifecycle", () => {
		let changeEventReceived = false;
		const unsubscribe = onThemeChange(event => {
			if (event.ephemeral) {
				changeEventReceived = true;
			}
		});

		try {
			const snapshot: PresentationTheme = {
				id: "live-apply-test",
				name: "Live Apply Test",
				appearance: "light",
				colors: {
					...Object.fromEntries(THEME_COLORS.map(k => [k, "#123456"])),
					accent: "#ff00aa",
				} as Record<ThemeColor, ColorValue>,
				backgrounds: {
					...Object.fromEntries(THEME_BG_COLORS.map(k => [k, "#ffffff"])),
					statusLineBg: "#fafafa",
				} as Record<ThemeBg, ColorValue>,
				symbolPreset: "ascii",
			};

			const applied = applyPresentationTheme(snapshot, { mode: "truecolor" });
			expect(theme).toBe(applied);
			expect(theme.isLight).toBe(true);
			expect(theme.getColorHex("accent")).toBe("#ff00aa");
			expect(theme.getSymbolPreset()).toBe("ascii");
			expect(changeEventReceived).toBe(true);
		} finally {
			unsubscribe();
		}
	});
});
