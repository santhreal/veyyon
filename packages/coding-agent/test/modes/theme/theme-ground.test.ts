/**
 * A theme's terminal ground color (`Theme.getGroundHex`) — the color the
 * painted-ground feature (`tui.paintGround`) sets as the terminal background.
 *
 * The ground is derived from the theme's `export.pageBg`, the same background
 * HTML export uses. It exists so the setting has a per-theme color to paint;
 * before this wiring the setting read nothing and did nothing. Two guarantees
 * matter and are pinned here:
 *
 *  1. A theme that declares a page background exposes it, resolved to an exact
 *     `#RRGGBB`, including when `pageBg` is written as a var reference.
 *  2. A theme that declares none, or one that is not a literal 6-digit hex,
 *     exposes `undefined` — never a half-formed value. The consumer then
 *     inherits the terminal background instead of feeding a bad color to OSC 11
 *     (`terminal.setBackgroundColor` throws on anything but `#RRGGBB`).
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTheme, getThemeByName } from "@veyyon/coding-agent/modes/theme/theme";
import { parseHexColor } from "@veyyon/tui";

const darkJson = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "../../../src/modes/theme/dark.json"), "utf-8"));

describe("Theme.getGroundHex from a real builtin theme", () => {
	it("returns the theme's declared page background verbatim", async () => {
		// dark.json declares export.pageBg "#000000"; a builtin's ground must be that
		// exact color so painting matches the theme rather than an approximation.
		const dark = await getThemeByName("dark");
		expect(dark?.getGroundHex()).toBe("#000000");
	});

	it("returns a distinct non-black ground for a colored theme", async () => {
		// dark-dracula declares export.pageBg "#1e1f29"; proving a second, different
		// value guards against the accessor accidentally returning a constant.
		const dracula = await getThemeByName("dark-dracula");
		expect(dracula?.getGroundHex()).toBe("#1e1f29");
	});

	it("resolves a var-referenced page background to a paintable hex", async () => {
		// amethyst writes export.pageBg as the var "caveDark"; the ground must be the
		// resolved #RRGGBB, not the literal var name, or OSC 11 painting would throw.
		const amethyst = await getThemeByName("amethyst");
		const ground = amethyst?.getGroundHex();
		expect(ground).toBeDefined();
		expect(parseHexColor(ground!)).not.toBeNull();
	});

	it("gives every builtin theme a paintable ground (none is left half-formed)", async () => {
		// The whole point of the wiring: for a builtin, the setting always has a real
		// color to act on. A ground that is defined but not #RRGGBB would crash the
		// consumer, so assert the pair for all of them.
		const dir = path.join(import.meta.dir, "../../../src/modes/theme/defaults");
		const names = fs
			.readdirSync(dir)
			.filter(f => f.endsWith(".json"))
			.map(f => f.replace(/\.json$/, ""));
		expect(names.length).toBeGreaterThan(50);
		for (const name of names) {
			const t = await getThemeByName(name);
			const ground = t?.getGroundHex();
			expect(ground, `${name} should declare a ground`).toBeDefined();
			expect(parseHexColor(ground!), `${name} ground ${ground} must be #RRGGBB`).not.toBeNull();
		}
	});
});

describe("Theme.getGroundHex resolution edges", () => {
	it("uses a literal hex page background exactly", () => {
		const theme = createTheme({ ...darkJson, export: { ...darkJson.export, pageBg: "#123456" } });
		expect(theme.getGroundHex()).toBe("#123456");
	});

	it("is undefined when the theme declares no export section at all", () => {
		// A user theme without `export` has no ground; the consumer inherits the
		// terminal background rather than inventing one.
		const theme = createTheme({ ...darkJson, export: undefined });
		expect(theme.getGroundHex()).toBeUndefined();
	});

	it("is undefined when pageBg is an unresolved var or malformed string", () => {
		// resolveThemeExportColors passes an unknown var through as-is; it is not a
		// paintable color, so it must resolve to no ground rather than reach OSC 11.
		const unresolved = createTheme({ ...darkJson, export: { ...darkJson.export, pageBg: "notAColor" } });
		expect(unresolved.getGroundHex()).toBeUndefined();
		const shortHex = createTheme({ ...darkJson, export: { ...darkJson.export, pageBg: "#12345" } });
		expect(shortHex.getGroundHex()).toBeUndefined();
	});
});
