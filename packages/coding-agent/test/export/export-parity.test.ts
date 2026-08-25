/**
 * Export palette, share server URL normalization, and constants.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. The export subsystem defines the web export color palette, share
 * server URL normalization, and the sealed-session size limit. These
 * contracts pin the exact palette values, URL normalization behavior, and
 * the byte ceiling.
 */
import { describe, expect, it } from "bun:test";
import {
	WEB_EXPORT_PALETTE,
	EXPORT_FALLBACK_BASE_BG,
	webExportThemeVars,
} from "@veyyon/coding-agent/export/html/web-palette";
import {
	DEFAULT_SHARE_URL,
	SERVER_MAX_SEALED_BYTES,
	normalizeShareServerUrl,
} from "@veyyon/coding-agent/export/share";

describe("web export palette", () => {
	it("EXPORT_FALLBACK_BASE_BG is #000000", () => {
		expect(EXPORT_FALLBACK_BASE_BG).toBe("#000000");
	});

	it("palette has pitch-black backgrounds", () => {
		expect(WEB_EXPORT_PALETTE["--bg"]).toBe("#000000");
		expect(WEB_EXPORT_PALETTE["--bg-raised"]).toBe("#000000");
		expect(WEB_EXPORT_PALETTE["--bg-inset"]).toBe("#000000");
		expect(WEB_EXPORT_PALETTE["--bg-overlay"]).toBe("#000000");
	});

	it("palette has ember accent", () => {
		expect(WEB_EXPORT_PALETTE["--accent"]).toBe("#f0862e");
	});

	it("palette has foreground colors", () => {
		expect(WEB_EXPORT_PALETTE["--fg"]).toBe("#f6f7f9");
		expect(WEB_EXPORT_PALETTE["--fg-muted"]).toBe("#b4bac4");
		expect(WEB_EXPORT_PALETTE["--fg-faint"]).toBe("#7c828d");
	});

	it("palette has status colors", () => {
		expect(WEB_EXPORT_PALETTE["--ok"]).toBe("#7fb98a");
		expect(WEB_EXPORT_PALETTE["--err"]).toBe("#c96f6e");
		expect(WEB_EXPORT_PALETTE["--warn"]).toBe("#c9a24b");
	});

	it("palette has a monospace font stack", () => {
		expect(WEB_EXPORT_PALETTE["--font-mono"]).toContain("ui-monospace");
		expect(WEB_EXPORT_PALETTE["--font-mono"]).toContain("monospace");
	});

	it("webExportThemeVars produces a CSS custom property string", () => {
		const vars = webExportThemeVars();
		expect(typeof vars).toBe("string");
		expect(vars).toContain("--bg:");
		expect(vars).toContain("--accent:");
		expect(vars.endsWith(";")).toBe(true);
	});
});

describe("share server URL normalization", () => {
	it("DEFAULT_SHARE_URL is the veyyon share endpoint", () => {
		expect(DEFAULT_SHARE_URL).toBe("https://share.veyyon.dev/s");
	});

	it("SERVER_MAX_SEALED_BYTES is 1MB", () => {
		expect(SERVER_MAX_SEALED_BYTES).toBe(1_000_000);
	});

	it("returns default when no URL provided", () => {
		expect(normalizeShareServerUrl()).toBe(DEFAULT_SHARE_URL);
	});

	it("returns default when empty string provided", () => {
		expect(normalizeShareServerUrl("")).toBe(DEFAULT_SHARE_URL);
	});

	it("returns default when whitespace-only string provided", () => {
		expect(normalizeShareServerUrl("   ")).toBe(DEFAULT_SHARE_URL);
	});

	it("trims trailing slashes", () => {
		expect(normalizeShareServerUrl("https://example.com/s/")).toBe("https://example.com/s");
	});

	it("trims multiple trailing slashes", () => {
		expect(normalizeShareServerUrl("https://example.com/s///")).toBe("https://example.com/s");
	});

	it("preserves a URL without trailing slash", () => {
		expect(normalizeShareServerUrl("https://example.com/s")).toBe("https://example.com/s");
	});

	it("trims leading/trailing whitespace", () => {
		expect(normalizeShareServerUrl("  https://example.com/s  ")).toBe("https://example.com/s");
	});
});
