import { describe, expect, it } from "bun:test";
import {
	ANTIGRAVITY_MODEL_WIRE_PROFILES,
	getAntigravityModelWireProfile,
	getAntigravityUserAgent,
	getGeminiCliHeaders,
	getGeminiCliUserAgent,
} from "../src/wire/gemini-headers";

describe("getGeminiCliUserAgent", () => {
	it("builds the GeminiCLI UA in the official version/model/platform format", () => {
		const version = process.env.VEYYON_AI_GEMINI_CLI_VERSION || "0.46.0";
		expect(getGeminiCliUserAgent("gemini-3.1-pro-preview")).toBe(
			`GeminiCLI/${version}/gemini-3.1-pro-preview (${process.platform}; ${process.arch}; terminal)`,
		);
	});

	it("defaults the model id when none is supplied", () => {
		expect(getGeminiCliUserAgent()).toContain("/gemini-3.1-pro-preview (");
	});
});

describe("getGeminiCliHeaders", () => {
	it("pairs the UA with the fixed Client-Metadata identity string", () => {
		const headers = getGeminiCliHeaders("gemini-3.1-pro-preview");
		expect(headers["User-Agent"]).toBe(getGeminiCliUserAgent("gemini-3.1-pro-preview"));
		expect(headers["Client-Metadata"]).toBe(
			"ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
		);
	});
});

describe("getAntigravityUserAgent", () => {
	it("maps the current platform/arch into Antigravity's antigravity/hub/<version> <os>/<arch> shape", () => {
		const version = process.env.VEYYON_AI_ANTIGRAVITY_VERSION || "2.1.4";
		const os = process.platform === "win32" ? "windows" : process.platform;
		const arch = process.arch === "x64" ? "amd64" : process.arch === "ia32" ? "386" : process.arch;
		expect(getAntigravityUserAgent()).toBe(`antigravity/hub/${version} ${os}/${arch}`);
	});

	it("memoizes: repeated calls return the identical string", () => {
		expect(getAntigravityUserAgent()).toBe(getAntigravityUserAgent());
	});
});

describe("getAntigravityModelWireProfile", () => {
	it("returns the per-wire profile for a known routed id", () => {
		expect(getAntigravityModelWireProfile("gemini-3.1-pro-low")).toEqual({
			modelEnum: "MODEL_PLACEHOLDER_M36",
			maxOutputTokens: 65535,
		});
	});

	it("caps Claude wire ids at 64000 output tokens with no model_enum label", () => {
		const profile = getAntigravityModelWireProfile("claude-sonnet-4-6");
		expect(profile?.maxOutputTokens).toBe(64000);
		expect(profile?.modelEnum).toBeUndefined();
	});

	it("returns undefined for an id absent from the wire-profile table", () => {
		expect(getAntigravityModelWireProfile("gemini-3.1-flash-lite")).toBeUndefined();
		expect(getAntigravityModelWireProfile("nonexistent")).toBeUndefined();
	});

	it("every table entry carries a positive maxOutputTokens", () => {
		for (const profile of Object.values(ANTIGRAVITY_MODEL_WIRE_PROFILES)) {
			expect(profile.maxOutputTokens).toBeGreaterThan(0);
		}
	});
});
