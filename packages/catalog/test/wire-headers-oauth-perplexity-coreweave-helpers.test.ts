import { describe, expect, it } from "bun:test";
import {
	COREWEAVE_PROJECT_HEADER,
	type CoreWeaveProjectEnv,
	coreWeaveProjectHeaders,
	hasCoreWeaveProjectHeader,
	removeBlankCoreWeaveProjectHeaders,
	resolveCoreWeaveProject,
} from "../src/wire/coreweave";
import {
	ANTIGRAVITY_MODEL_WIRE_PROFILES,
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	type AntigravityModelWireProfile,
	getAntigravityModelWireProfile,
	getAntigravityUserAgent,
	getGeminiCliHeaders,
	getGeminiCliUserAgent,
} from "../src/wire/gemini-headers";
import {
	GOOGLE_BASE_OAUTH_SCOPES,
	GOOGLE_OAUTH_AUTH_ENDPOINT,
	GOOGLE_OAUTH_TOKEN_ENDPOINT,
	GOOGLE_SCOPE_CLOUD_PLATFORM,
	GOOGLE_SCOPE_USERINFO_EMAIL,
	GOOGLE_SCOPE_USERINFO_PROFILE,
} from "../src/wire/google-oauth";
import {
	PERPLEXITY_HEADERS,
	PERPLEXITY_NATIVE_APP_API_VERSION,
	PERPLEXITY_NATIVE_APP_BUNDLE_ID,
	PERPLEXITY_NATIVE_APP_HEADERS,
	PERPLEXITY_NATIVE_APP_USER_AGENT,
	PERPLEXITY_WEB_ORIGIN,
} from "../src/wire/perplexity";

describe("getGeminiCliUserAgent", () => {
	it("returns user agent with default model", () => {
		const ua = getGeminiCliUserAgent();
		expect(ua).toContain("GeminiCLI/");
		expect(ua).toContain("gemini-3.1-pro-preview");
	});
	it("returns user agent with custom model", () => {
		const ua = getGeminiCliUserAgent("gemini-2.0-flash");
		expect(ua).toContain("gemini-2.0-flash");
	});
	it("includes platform and arch", () => {
		const ua = getGeminiCliUserAgent();
		expect(ua).toContain(process.platform);
		expect(ua).toContain(process.arch);
	});
	it("includes version from env", () => {
		const orig = process.env.VEYYON_AI_GEMINI_CLI_VERSION;
		process.env.VEYYON_AI_GEMINI_CLI_VERSION = "1.0.0";
		try {
			expect(getGeminiCliUserAgent()).toContain("1.0.0");
		} finally {
			if (orig === undefined) delete process.env.VEYYON_AI_GEMINI_CLI_VERSION;
			else process.env.VEYYON_AI_GEMINI_CLI_VERSION = orig;
		}
	});
});

describe("getGeminiCliHeaders", () => {
	it("returns User-Agent header", () => {
		const headers = getGeminiCliHeaders();
		expect(headers["User-Agent"]).toContain("GeminiCLI/");
	});
	it("returns Client-Metadata header", () => {
		const headers = getGeminiCliHeaders();
		expect(headers["Client-Metadata"]).toContain("ideType=IDE_UNSPECIFIED");
	});
	it("passes modelId to user agent", () => {
		const headers = getGeminiCliHeaders("gemini-2.0-flash");
		expect(headers["User-Agent"]).toContain("gemini-2.0-flash");
	});
});

describe("ANTIGRAVITY_SYSTEM_INSTRUCTION", () => {
	it("is a non-empty string", () => {
		expect(ANTIGRAVITY_SYSTEM_INSTRUCTION.length).toBeGreaterThan(0);
	});
	it("mentions Antigravity", () => {
		expect(ANTIGRAVITY_SYSTEM_INSTRUCTION).toContain("Antigravity");
	});
	it("mentions absolute paths", () => {
		expect(ANTIGRAVITY_SYSTEM_INSTRUCTION).toContain("Absolute paths only");
	});
});

describe("getAntigravityUserAgent", () => {
	it("returns user agent with version", () => {
		const ua = getAntigravityUserAgent();
		expect(ua).toContain("antigravity/hub/");
	});
	it("includes os and arch", () => {
		const ua = getAntigravityUserAgent();
		expect(ua).toContain("/");
	});
	it("maps x64 to amd64", () => {
		const ua = getAntigravityUserAgent();
		if (process.arch === "x64") expect(ua).toContain("amd64");
	});
	it("maps win32 to windows", () => {
		const ua = getAntigravityUserAgent();
		if (process.platform === "win32") expect(ua).toContain("windows");
	});
});

describe("ANTIGRAVITY_MODEL_WIRE_PROFILES", () => {
	it("has profiles for known models", () => {
		expect(ANTIGRAVITY_MODEL_WIRE_PROFILES["gemini-3.5-flash-extra-low"]).toBeDefined();
		expect(ANTIGRAVITY_MODEL_WIRE_PROFILES["gemini-3.5-flash-low"]).toBeDefined();
		expect(ANTIGRAVITY_MODEL_WIRE_PROFILES["gemini-3-flash-agent"]).toBeDefined();
	});
	it("every profile has maxOutputTokens", () => {
		for (const profile of Object.values(ANTIGRAVITY_MODEL_WIRE_PROFILES)) {
			expect(profile.maxOutputTokens).toBeGreaterThan(0);
		}
	});
	it("some profiles have modelEnum", () => {
		const withEnum = Object.values(ANTIGRAVITY_MODEL_WIRE_PROFILES).filter(
			(p: AntigravityModelWireProfile) => p.modelEnum,
		);
		expect(withEnum.length).toBeGreaterThan(0);
	});
});

describe("getAntigravityModelWireProfile", () => {
	it("returns profile for known model", () => {
		const profile = getAntigravityModelWireProfile("gemini-3.5-flash-low");
		expect(profile?.modelEnum).toBe("MODEL_PLACEHOLDER_M20");
	});
	it("returns undefined for unknown model", () => {
		expect(getAntigravityModelWireProfile("unknown-model")).toBeUndefined();
	});
	it("returns profile without modelEnum", () => {
		const profile = getAntigravityModelWireProfile("gemini-3.6-flash-tiered");
		expect(profile?.modelEnum).toBeUndefined();
		expect(profile?.maxOutputTokens).toBe(65536);
	});
});

describe("Google OAuth constants", () => {
	it("GOOGLE_OAUTH_AUTH_ENDPOINT", () => {
		expect(GOOGLE_OAUTH_AUTH_ENDPOINT).toBe("https://accounts.google.com/o/oauth2/v2/auth");
	});
	it("GOOGLE_OAUTH_TOKEN_ENDPOINT", () => {
		expect(GOOGLE_OAUTH_TOKEN_ENDPOINT).toBe("https://oauth2.googleapis.com/token");
	});
	it("GOOGLE_SCOPE_CLOUD_PLATFORM", () => {
		expect(GOOGLE_SCOPE_CLOUD_PLATFORM).toBe("https://www.googleapis.com/auth/cloud-platform");
	});
	it("GOOGLE_SCOPE_USERINFO_EMAIL", () => {
		expect(GOOGLE_SCOPE_USERINFO_EMAIL).toBe("https://www.googleapis.com/auth/userinfo.email");
	});
	it("GOOGLE_SCOPE_USERINFO_PROFILE", () => {
		expect(GOOGLE_SCOPE_USERINFO_PROFILE).toBe("https://www.googleapis.com/auth/userinfo.profile");
	});
	it("GOOGLE_BASE_OAUTH_SCOPES has 3 scopes", () => {
		expect(GOOGLE_BASE_OAUTH_SCOPES).toHaveLength(3);
	});
	it("GOOGLE_BASE_OAUTH_SCOPES contains all scopes", () => {
		expect(GOOGLE_BASE_OAUTH_SCOPES).toContain(GOOGLE_SCOPE_CLOUD_PLATFORM);
		expect(GOOGLE_BASE_OAUTH_SCOPES).toContain(GOOGLE_SCOPE_USERINFO_EMAIL);
		expect(GOOGLE_BASE_OAUTH_SCOPES).toContain(GOOGLE_SCOPE_USERINFO_PROFILE);
	});
});

describe("Perplexity constants", () => {
	it("PERPLEXITY_WEB_ORIGIN", () => {
		expect(PERPLEXITY_WEB_ORIGIN).toBe("https://www.perplexity.ai");
	});
	it("PERPLEXITY_NATIVE_APP_BUNDLE_ID", () => {
		expect(PERPLEXITY_NATIVE_APP_BUNDLE_ID).toBe("ai.perplexity.mac");
	});
	it("PERPLEXITY_NATIVE_APP_USER_AGENT", () => {
		expect(PERPLEXITY_NATIVE_APP_USER_AGENT).toContain("Perplexity/");
	});
	it("PERPLEXITY_NATIVE_APP_API_VERSION", () => {
		expect(PERPLEXITY_NATIVE_APP_API_VERSION).toBe("2.18");
	});
	it("PERPLEXITY_HEADERS has expected keys", () => {
		expect(PERPLEXITY_HEADERS.API_VERSION).toBe("X-App-ApiVersion");
		expect(PERPLEXITY_HEADERS.API_CLIENT).toBe("X-App-ApiClient");
		expect(PERPLEXITY_HEADERS.REQUEST_ID).toBe("X-Request-ID");
		expect(PERPLEXITY_HEADERS.REQUEST_REASON).toBe("X-Perplexity-Request-Reason");
	});
	it("PERPLEXITY_NATIVE_APP_HEADERS has User-Agent and API version", () => {
		expect(PERPLEXITY_NATIVE_APP_HEADERS["User-Agent"]).toBe(PERPLEXITY_NATIVE_APP_USER_AGENT);
		expect(PERPLEXITY_NATIVE_APP_HEADERS[PERPLEXITY_HEADERS.API_VERSION]).toBe(PERPLEXITY_NATIVE_APP_API_VERSION);
	});
});

describe("resolveCoreWeaveProject", () => {
	it("returns COREWEAVE_PROJECT when set", () => {
		const env: CoreWeaveProjectEnv = { COREWEAVE_PROJECT: "my-project" };
		expect(resolveCoreWeaveProject(env)).toBe("my-project");
	});
	it("returns WANDB_INFERENCE_PROJECT when COREWEAVE_PROJECT not set", () => {
		const env: CoreWeaveProjectEnv = { WANDB_INFERENCE_PROJECT: "wandb-proj" };
		expect(resolveCoreWeaveProject(env)).toBe("wandb-proj");
	});
	it("COREWEAVE_PROJECT takes priority over WANDB_INFERENCE_PROJECT", () => {
		const env: CoreWeaveProjectEnv = { COREWEAVE_PROJECT: "primary", WANDB_INFERENCE_PROJECT: "secondary" };
		expect(resolveCoreWeaveProject(env)).toBe("primary");
	});
	it("returns WANDB_PROJECT with slash as-is", () => {
		const env: CoreWeaveProjectEnv = { WANDB_PROJECT: "entity/project" };
		expect(resolveCoreWeaveProject(env)).toBe("entity/project");
	});
	it("combines WANDB_ENTITY and WANDB_PROJECT", () => {
		const env: CoreWeaveProjectEnv = { WANDB_ENTITY: "my-entity", WANDB_PROJECT: "my-project" };
		expect(resolveCoreWeaveProject(env)).toBe("my-entity/my-project");
	});
	it("returns undefined when WANDB_PROJECT set but no entity", () => {
		const env: CoreWeaveProjectEnv = { WANDB_PROJECT: "project-only" };
		expect(resolveCoreWeaveProject(env)).toBeUndefined();
	});
	it("returns undefined for empty env", () => {
		expect(resolveCoreWeaveProject({})).toBeUndefined();
	});
	it("trims whitespace from values", () => {
		const env: CoreWeaveProjectEnv = { COREWEAVE_PROJECT: "  spaced  " };
		expect(resolveCoreWeaveProject(env)).toBe("spaced");
	});
	it("treats whitespace-only as undefined", () => {
		const env: CoreWeaveProjectEnv = { COREWEAVE_PROJECT: "   " };
		expect(resolveCoreWeaveProject(env)).toBeUndefined();
	});
});

describe("coreWeaveProjectHeaders", () => {
	it("returns header with project", () => {
		const env: CoreWeaveProjectEnv = { COREWEAVE_PROJECT: "my-project" };
		const headers = coreWeaveProjectHeaders(env);
		expect(headers?.[COREWEAVE_PROJECT_HEADER]).toBe("my-project");
	});
	it("returns undefined when no project", () => {
		expect(coreWeaveProjectHeaders({})).toBeUndefined();
	});
});

describe("hasCoreWeaveProjectHeader", () => {
	it("returns true when header present", () => {
		expect(hasCoreWeaveProjectHeader({ [COREWEAVE_PROJECT_HEADER]: "proj" })).toBe(true);
	});
	it("returns true when header present case-insensitively", () => {
		expect(hasCoreWeaveProjectHeader({ "openai-project": "proj" })).toBe(true);
	});
	it("returns false when header absent", () => {
		expect(hasCoreWeaveProjectHeader({ "Other-Header": "value" })).toBe(false);
	});
	it("returns false when header value is blank", () => {
		expect(hasCoreWeaveProjectHeader({ [COREWEAVE_PROJECT_HEADER]: "  " })).toBe(false);
	});
	it("returns false for empty headers", () => {
		expect(hasCoreWeaveProjectHeader({})).toBe(false);
	});
});

describe("removeBlankCoreWeaveProjectHeaders", () => {
	it("removes blank header", () => {
		const headers: Record<string, string> = { [COREWEAVE_PROJECT_HEADER]: "  " };
		removeBlankCoreWeaveProjectHeaders(headers);
		expect(headers[COREWEAVE_PROJECT_HEADER]).toBeUndefined();
	});
	it("does not remove non-blank header", () => {
		const headers: Record<string, string> = { [COREWEAVE_PROJECT_HEADER]: "proj" };
		removeBlankCoreWeaveProjectHeaders(headers);
		expect(headers[COREWEAVE_PROJECT_HEADER]).toBe("proj");
	});
	it("removes blank header case-insensitively", () => {
		const headers: Record<string, string> = { "OPENAI-PROJECT": "  " };
		removeBlankCoreWeaveProjectHeaders(headers);
		expect(headers["OPENAI-PROJECT"]).toBeUndefined();
	});
	it("does not touch other headers", () => {
		const headers: Record<string, string> = { "Other-Header": "value", [COREWEAVE_PROJECT_HEADER]: "" };
		removeBlankCoreWeaveProjectHeaders(headers);
		expect(headers["Other-Header"]).toBe("value");
		expect(headers[COREWEAVE_PROJECT_HEADER]).toBeUndefined();
	});
	it("handles empty headers object", () => {
		const headers: Record<string, string> = {};
		removeBlankCoreWeaveProjectHeaders(headers);
		expect(Object.keys(headers)).toHaveLength(0);
	});
});
