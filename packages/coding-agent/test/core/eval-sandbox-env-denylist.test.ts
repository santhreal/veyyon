/**
 * SPEC-ONE-PLACE-AUDIT F3: the py/rb/jl eval sandboxes must all route through
 * the shared `createEnvFilter` with the unified `SECRET_ENV_DENYLIST`, so a
 * secret-shaped var like `PI_SESSION` cannot leak into one language's
 * sandbox while being denied in another (the original bug: Julia denied it,
 * Python and Ruby did not).
 */
import { describe, expect, it } from "bun:test";
import { filterEnv as filterJuliaEnv } from "@veyyon/pi-coding-agent/eval/jl/runtime";
import { filterEnv as filterPythonEnv } from "@veyyon/pi-coding-agent/eval/py/runtime";
import { filterEnv as filterRubyEnv } from "@veyyon/pi-coding-agent/eval/rb/runtime";
import { CASE_INSENSITIVE_ENV, SECRET_ENV_DENYLIST } from "@veyyon/pi-coding-agent/eval/runtime-env";

const LANGUAGE_FILTERS: Record<
	string,
	(env: Record<string, string | undefined>) => Record<string, string | undefined>
> = {
	python: filterPythonEnv,
	ruby: filterRubyEnv,
	julia: filterJuliaEnv,
};

const SECRET_PROBE_ENV = {
	PI_SESSION: "leaked-session",
	PI_TOKEN: "leaked-token",
	PI_API_KEY: "leaked-pi-key",
	PI_PASSWORD: "leaked-pi-password",
	PI_TOOL_BRIDGE_TOKEN: "leaked-bridge-token",
	OPENAI_API_KEY: "leaked-openai",
	ANTHROPIC_API_KEY: "leaked-anthropic",
	GOOGLE_API_KEY: "leaked-google",
	GEMINI_API_KEY: "leaked-gemini",
	OPENROUTER_API_KEY: "leaked-openrouter",
	PERPLEXITY_API_KEY: "leaked-perplexity",
	PERPLEXITY_COOKIES: "leaked-perplexity-cookies",
	EXA_API_KEY: "leaked-exa",
	AZURE_OPENAI_API_KEY: "leaked-azure",
	MISTRAL_API_KEY: "leaked-mistral",
};

describe("eval sandbox secret env denylist (F3)", () => {
	for (const [language, filterEnv] of Object.entries(LANGUAGE_FILTERS)) {
		it(`${language} sandbox strips PI_SESSION, PI_TOKEN, and every provider key`, () => {
			const filtered = filterEnv({ ...SECRET_PROBE_ENV });
			expect(filtered).toEqual({});
		});
	}

	it("PI_SESSION is admitted by the PI_ allow-prefix unless the denylist catches it first (regression guard)", () => {
		// PI_ is a legitimate allow-prefix (internal config vars like PI_CUSTOM);
		// PI_SESSION must be denylisted explicitly, not merely un-matched by
		// SECRET_KEY_PATTERN (which does not match "SESSION").
		for (const filterEnv of Object.values(LANGUAGE_FILTERS)) {
			expect(filterEnv({ PI_SESSION: "x", PI_CUSTOM: "1" })).toEqual({ PI_CUSTOM: "1" });
		}
	});

	it("SECRET_ENV_DENYLIST is the single authoritative source (union of PI-internal + provider keys)", () => {
		const denylistKey = CASE_INSENSITIVE_ENV ? "PI_SESSION".toUpperCase() : "PI_SESSION";
		expect(SECRET_ENV_DENYLIST.map(k => (CASE_INSENSITIVE_ENV ? k.toUpperCase() : k))).toContain(denylistKey);
		expect(SECRET_ENV_DENYLIST).toContain("OPENAI_API_KEY");
		expect(SECRET_ENV_DENYLIST).toContain("PI_TOKEN");
	});
});
