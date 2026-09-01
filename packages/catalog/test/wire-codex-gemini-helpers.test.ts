import { describe, expect, it } from "bun:test";
import {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	CODEX_JWT_AUTH_CLAIM,
	CODEX_JWT_PROFILE_CLAIM,
	getCodexAccountEmail,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
	readCodexClaimsFromPayload,
	readCodexTokenIdentity,
	URL_PATHS,
} from "../src/wire/codex";
import {
	ANTIGRAVITY_MODEL_WIRE_PROFILES,
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	getAntigravityModelWireProfile,
	getAntigravityUserAgent,
	getGeminiCliHeaders,
	getGeminiCliUserAgent,
} from "../src/wire/gemini-headers";

describe("codex constants", () => {
	it("CODEX_BASE_URL is correct", () => {
		expect(CODEX_BASE_URL).toBe("https://chatgpt.com/backend-api");
	});
	it("CODEX_CLIENT_VERSION is correct", () => {
		expect(CODEX_CLIENT_VERSION).toBe("0.144.1");
	});
	it("OPENAI_HEADERS has BETA", () => {
		expect(OPENAI_HEADERS.BETA).toBe("OpenAI-Beta");
	});
	it("OPENAI_HEADERS has ACCOUNT_ID", () => {
		expect(OPENAI_HEADERS.ACCOUNT_ID).toBe("chatgpt-account-id");
	});
	it("OPENAI_HEADER_VALUES has BETA_RESPONSES", () => {
		expect(OPENAI_HEADER_VALUES.BETA_RESPONSES).toBe("responses=experimental");
	});
	it("OPENAI_HEADER_VALUES has ORIGINATOR_CODEX", () => {
		expect(OPENAI_HEADER_VALUES.ORIGINATOR_CODEX).toBe("pi");
	});
	it("URL_PATHS has RESPONSES", () => {
		expect(URL_PATHS.RESPONSES).toBe("/responses");
	});
	it("URL_PATHS has CODEX_RESPONSES", () => {
		expect(URL_PATHS.CODEX_RESPONSES).toBe("/codex/responses");
	});
	it("CODEX_JWT_AUTH_CLAIM is correct", () => {
		expect(CODEX_JWT_AUTH_CLAIM).toBe("https://api.openai.com/auth");
	});
	it("CODEX_JWT_PROFILE_CLAIM is correct", () => {
		expect(CODEX_JWT_PROFILE_CLAIM).toBe("https://api.openai.com/profile");
	});
});

describe("readCodexClaimsFromPayload", () => {
	it("extracts account id and email", () => {
		const payload = {
			[CODEX_JWT_AUTH_CLAIM]: { chatgpt_account_id: "acct-123" },
			[CODEX_JWT_PROFILE_CLAIM]: { email: "User@Example.com" },
		};
		const result = readCodexClaimsFromPayload(payload);
		expect(result.accountId).toBe("acct-123");
		expect(result.email).toBe("user@example.com");
	});
	it("returns empty for missing claims", () => {
		expect(readCodexClaimsFromPayload({})).toEqual({});
	});
	it("returns empty for null claims", () => {
		const payload = {
			[CODEX_JWT_AUTH_CLAIM]: null,
			[CODEX_JWT_PROFILE_CLAIM]: null,
		};
		expect(readCodexClaimsFromPayload(payload)).toEqual({});
	});
	it("returns empty for non-object claims", () => {
		const payload = {
			[CODEX_JWT_AUTH_CLAIM]: "string",
			[CODEX_JWT_PROFILE_CLAIM]: 42,
		};
		expect(readCodexClaimsFromPayload(payload)).toEqual({});
	});
	it("handles whitespace-only account id", () => {
		const payload = {
			[CODEX_JWT_AUTH_CLAIM]: { chatgpt_account_id: "   " },
		};
		expect(readCodexClaimsFromPayload(payload).accountId).toBeUndefined();
	});
	it("handles whitespace-only email", () => {
		const payload = {
			[CODEX_JWT_PROFILE_CLAIM]: { email: "  " },
		};
		expect(readCodexClaimsFromPayload(payload).email).toBeUndefined();
	});
	it("handles non-string account id", () => {
		const payload = {
			[CODEX_JWT_AUTH_CLAIM]: { chatgpt_account_id: 42 },
		};
		expect(readCodexClaimsFromPayload(payload).accountId).toBeUndefined();
	});
	it("lowercases email", () => {
		const payload = {
			[CODEX_JWT_PROFILE_CLAIM]: { email: "USER@EXAMPLE.COM" },
		};
		expect(readCodexClaimsFromPayload(payload).email).toBe("user@example.com");
	});
});

describe("readCodexTokenIdentity", () => {
	it("returns empty for undefined token", () => {
		expect(readCodexTokenIdentity(undefined)).toEqual({});
	});
	it("returns empty for empty string", () => {
		expect(readCodexTokenIdentity("")).toEqual({});
	});
	it("returns empty for invalid JWT", () => {
		expect(readCodexTokenIdentity("not-a-jwt")).toEqual({});
	});
});

describe("getCodexAccountId", () => {
	it("returns undefined for undefined token", () => {
		expect(getCodexAccountId(undefined)).toBeUndefined();
	});
});

describe("getCodexAccountEmail", () => {
	it("returns undefined for undefined token", () => {
		expect(getCodexAccountEmail(undefined)).toBeUndefined();
	});
});

describe("getGeminiCliUserAgent", () => {
	it("returns string with GeminiCLI prefix", () => {
		expect(getGeminiCliUserAgent()).toContain("GeminiCLI/");
	});
	it("includes model id", () => {
		expect(getGeminiCliUserAgent("gemini-2.0-flash")).toContain("gemini-2.0-flash");
	});
	it("includes platform and arch", () => {
		const ua = getGeminiCliUserAgent();
		expect(ua).toContain(process.platform);
		expect(ua).toContain(process.arch);
	});
	it("uses default model when not specified", () => {
		expect(getGeminiCliUserAgent()).toContain("gemini-3.1-pro-preview");
	});
});

describe("getGeminiCliHeaders", () => {
	it("returns User-Agent header", () => {
		const headers = getGeminiCliHeaders();
		expect(headers["User-Agent"]).toContain("GeminiCLI/");
	});
	it("returns Client-Metadata header", () => {
		const headers = getGeminiCliHeaders();
		expect(headers["Client-Metadata"]).toContain("GEMINI");
	});
	it("passes model id to user agent", () => {
		const headers = getGeminiCliHeaders("gemini-2.0-flash");
		expect(headers["User-Agent"]).toContain("gemini-2.0-flash");
	});
});

describe("ANTIGRAVITY_SYSTEM_INSTRUCTION", () => {
	it("is non-empty string", () => {
		expect(ANTIGRAVITY_SYSTEM_INSTRUCTION.length).toBeGreaterThan(0);
	});
	it("mentions Antigravity", () => {
		expect(ANTIGRAVITY_SYSTEM_INSTRUCTION).toContain("Antigravity");
	});
	it("mentions absolute paths", () => {
		expect(ANTIGRAVITY_SYSTEM_INSTRUCTION).toContain("Absolute paths");
	});
});

describe("getAntigravityUserAgent", () => {
	it("returns string with antigravity prefix", () => {
		expect(getAntigravityUserAgent()).toContain("antigravity/");
	});
	it("includes os and arch", () => {
		const ua = getAntigravityUserAgent();
		expect(ua).toContain("/");
	});
});

describe("ANTIGRAVITY_MODEL_WIRE_PROFILES", () => {
	it("has profile for gemini-3.5-flash-extra-low", () => {
		expect(ANTIGRAVITY_MODEL_WIRE_PROFILES["gemini-3.5-flash-extra-low"]).toBeDefined();
	});
	it("has maxOutputTokens for each profile", () => {
		for (const profile of Object.values(ANTIGRAVITY_MODEL_WIRE_PROFILES)) {
			expect(profile.maxOutputTokens).toBeGreaterThan(0);
		}
	});
});

describe("getAntigravityModelWireProfile", () => {
	it("returns profile for known model", () => {
		const profile = getAntigravityModelWireProfile("gemini-3.5-flash-extra-low");
		expect(profile).toBeDefined();
		expect(profile?.maxOutputTokens).toBe(65536);
	});
	it("returns undefined for unknown model", () => {
		expect(getAntigravityModelWireProfile("unknown-model")).toBeUndefined();
	});
	it("returns profile with modelEnum for some models", () => {
		const profile = getAntigravityModelWireProfile("gemini-3.5-flash-extra-low");
		expect(profile?.modelEnum).toBeDefined();
	});
	it("returns profile without modelEnum for tiered models", () => {
		const profile = getAntigravityModelWireProfile("gemini-3.6-flash-tiered");
		expect(profile?.modelEnum).toBeUndefined();
	});
});
