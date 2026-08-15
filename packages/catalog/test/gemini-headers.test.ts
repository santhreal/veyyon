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

	it("pins the tiered flash deployments at the discovered Gemini cap with no model_enum label", () => {
		for (const id of ["gemini-3.6-flash-tiered", "gemini-3.7-flash-tiered"]) {
			const profile = getAntigravityModelWireProfile(id);
			expect(profile?.maxOutputTokens).toBe(65536);
			expect(profile?.modelEnum).toBeUndefined();
		}
	});

	/**
	 * LOCKS OUT: a wire profile whose maxOutputTokens the backend rejects.
	 *
	 * This replaced `expect(profile.maxOutputTokens).toBeGreaterThan(0)`, which
	 * passed for every value the backend actually refuses. The two Claude ids are
	 * the ones that matter: `daily-cloudcode-pa` answers 400 `Request contains an
	 * invalid argument` above 64,000, so a copy-paste of the Gemini 65,536 into
	 * either row breaks every Claude turn through Antigravity, and the old
	 * assertion called it correct.
	 *
	 * The whole table is pinned rather than sampled, because a new row is exactly
	 * where the wrong ceiling gets pasted.
	 */
	it("holds the exact per-id ceiling the backend accepts", () => {
		expect(ANTIGRAVITY_MODEL_WIRE_PROFILES).toEqual({
			"gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65536 },
			"gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
			"gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65536 },
			"gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65535 },
			"gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65535 },
			"gemini-3.6-flash-tiered": { maxOutputTokens: 65536 },
			"gemini-3.7-flash-tiered": { maxOutputTokens: 65536 },
			"claude-sonnet-4-6": { maxOutputTokens: 64000 },
			"claude-opus-4-6-thinking": { maxOutputTokens: 64000 },
		});
		// Named separately: every Claude id stays at or under the 64,000 the
		// backend enforces, whatever else is added to the table above.
		for (const [id, profile] of Object.entries(ANTIGRAVITY_MODEL_WIRE_PROFILES)) {
			if (!id.startsWith("claude-")) continue;
			expect(profile.maxOutputTokens).toBeLessThanOrEqual(64000);
		}
	});
});
