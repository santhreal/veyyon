import { describe, expect, it } from "bun:test";
import {
	COREWEAVE_PROJECT_HEADER,
	coreWeaveProjectHeaders,
	hasCoreWeaveProjectHeader,
	removeBlankCoreWeaveProjectHeaders,
	resolveCoreWeaveProject,
} from "../src/wire/coreweave";
import {
	COPILOT_API_HEADERS,
	COPILOT_API_VERSION,
	COPILOT_USER_AGENT,
	GITHUB_REST_API_VERSION,
	GITHUB_REST_HEADERS,
	getGitHubCopilotBaseUrl,
	isPersonalGitHubCopilotBaseUrl,
	isPublicGitHubHost,
	normalizeDomain,
	normalizeGitHubCopilotApiEndpoint,
	normalizeGitHubCopilotEnterpriseDomain,
	OPENCODE_HEADERS,
	PERSONAL_GITHUB_COPILOT_BASE_URL,
	parseGitHubCopilotApiKey,
} from "../src/wire/github-copilot";
import {
	GOOGLE_BASE_OAUTH_SCOPES,
	GOOGLE_OAUTH_AUTH_ENDPOINT,
	GOOGLE_OAUTH_TOKEN_ENDPOINT,
	GOOGLE_SCOPE_CLOUD_PLATFORM,
} from "../src/wire/google-oauth";
import {
	PERPLEXITY_HEADERS,
	PERPLEXITY_NATIVE_APP_API_VERSION,
	PERPLEXITY_NATIVE_APP_BUNDLE_ID,
	PERPLEXITY_NATIVE_APP_HEADERS,
	PERPLEXITY_NATIVE_APP_USER_AGENT,
	PERPLEXITY_WEB_ORIGIN,
} from "../src/wire/perplexity";

describe("github-copilot constants", () => {
	it("COPILOT_USER_AGENT is correct", () => {
		expect(COPILOT_USER_AGENT).toBe("opencode/1.3.15");
	});
	it("COPILOT_API_VERSION is correct", () => {
		expect(COPILOT_API_VERSION).toBe("2026-06-01");
	});
	it("GITHUB_REST_API_VERSION is correct", () => {
		expect(GITHUB_REST_API_VERSION).toBe("2022-11-28");
	});
	it("PERSONAL_GITHUB_COPILOT_BASE_URL is correct", () => {
		expect(PERSONAL_GITHUB_COPILOT_BASE_URL).toBe("https://api.githubcopilot.com");
	});
	it("OPENCODE_HEADERS has User-Agent", () => {
		expect(OPENCODE_HEADERS["User-Agent"]).toBe(COPILOT_USER_AGENT);
	});
	it("COPILOT_API_HEADERS has api version", () => {
		expect(COPILOT_API_HEADERS["X-GitHub-Api-Version"]).toBe(COPILOT_API_VERSION);
	});
	it("GITHUB_REST_HEADERS has api version", () => {
		expect(GITHUB_REST_HEADERS["X-GitHub-Api-Version"]).toBe(GITHUB_REST_API_VERSION);
	});
});

describe("isPublicGitHubHost", () => {
	it("returns true for api.github.com", () => {
		expect(isPublicGitHubHost("api.github.com")).toBe(true);
	});
	it("returns true for github.com", () => {
		expect(isPublicGitHubHost("github.com")).toBe(true);
	});
	it("returns true for www.github.com", () => {
		expect(isPublicGitHubHost("www.github.com")).toBe(true);
	});
	it("returns false for enterprise host", () => {
		expect(isPublicGitHubHost("github.enterprise.com")).toBe(false);
	});
	it("is case-insensitive", () => {
		expect(isPublicGitHubHost("API.GITHUB.COM")).toBe(true);
	});
	it("trims whitespace", () => {
		expect(isPublicGitHubHost("  api.github.com  ")).toBe(true);
	});
});

describe("isPersonalGitHubCopilotBaseUrl", () => {
	it("returns true for personal base url", () => {
		expect(isPersonalGitHubCopilotBaseUrl(PERSONAL_GITHUB_COPILOT_BASE_URL)).toBe(true);
	});
	it("returns false for enterprise url", () => {
		expect(isPersonalGitHubCopilotBaseUrl("https://copilot-api.github.enterprise.com")).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isPersonalGitHubCopilotBaseUrl(undefined)).toBe(false);
	});
});

describe("normalizeDomain", () => {
	it("extracts hostname from URL", () => {
		expect(normalizeDomain("https://example.com/path")).toBe("example.com");
	});
	it("extracts hostname from bare domain", () => {
		expect(normalizeDomain("example.com")).toBe("example.com");
	});
	it("returns null for empty string", () => {
		expect(normalizeDomain("")).toBeNull();
	});
	it("returns null for whitespace-only string", () => {
		expect(normalizeDomain("  ")).toBeNull();
	});
	it("handles domain with port", () => {
		expect(normalizeDomain("https://example.com:8080")).toBe("example.com");
	});
});

describe("normalizeGitHubCopilotEnterpriseDomain", () => {
	it("returns undefined for empty input", () => {
		expect(normalizeGitHubCopilotEnterpriseDomain(undefined)).toBeUndefined();
	});
	it("returns undefined for public github host", () => {
		expect(normalizeGitHubCopilotEnterpriseDomain("github.com")).toBeUndefined();
	});
	it("returns normalized enterprise domain", () => {
		expect(normalizeGitHubCopilotEnterpriseDomain("GitHub.Enterprise.com")).toBe("github.enterprise.com");
	});
	it("returns undefined for whitespace-only input", () => {
		expect(normalizeGitHubCopilotEnterpriseDomain("  ")).toBeUndefined();
	});
});

describe("normalizeGitHubCopilotApiEndpoint", () => {
	it("returns undefined for non-https input", () => {
		expect(normalizeGitHubCopilotApiEndpoint("http://example.com")).toBeUndefined();
	});
	it("returns undefined for empty input", () => {
		expect(normalizeGitHubCopilotApiEndpoint(undefined)).toBeUndefined();
	});
	it("returns trimmed URL for valid https endpoint", () => {
		expect(normalizeGitHubCopilotApiEndpoint("https://example.com/api/")).toBe("https://example.com/api");
	});
	it("returns undefined for invalid URL", () => {
		expect(normalizeGitHubCopilotApiEndpoint("https://")).toBeUndefined();
	});
});

describe("parseGitHubCopilotApiKey", () => {
	it("parses JSON with token", () => {
		const key = JSON.stringify({ token: "abc123" });
		const result = parseGitHubCopilotApiKey(key);
		expect(result.accessToken).toBe("abc123");
	});
	it("parses JSON with token and enterprise url", () => {
		const key = JSON.stringify({ token: "abc123", enterpriseUrl: "github.enterprise.com" });
		const result = parseGitHubCopilotApiKey(key);
		expect(result.accessToken).toBe("abc123");
		expect(result.enterpriseUrl).toBe("github.enterprise.com");
	});
	it("returns raw string for non-JSON input", () => {
		const result = parseGitHubCopilotApiKey("raw-key");
		expect(result.accessToken).toBe("raw-key");
	});
	it("returns raw string for JSON without token", () => {
		const result = parseGitHubCopilotApiKey('{"foo":"bar"}');
		expect(result.accessToken).toBe('{"foo":"bar"}');
	});
	it("parses JSON with apiEndpoint", () => {
		const key = JSON.stringify({ token: "abc", apiEndpoint: "https://api.example.com" });
		const result = parseGitHubCopilotApiKey(key);
		expect(result.apiEndpoint).toBe("https://api.example.com");
	});
});

describe("getGitHubCopilotBaseUrl", () => {
	it("returns personal URL for no enterprise domain", () => {
		expect(getGitHubCopilotBaseUrl()).toBe("https://api.githubcopilot.com");
	});
	it("returns personal URL for public github host", () => {
		expect(getGitHubCopilotBaseUrl("github.com")).toBe("https://api.githubcopilot.com");
	});
	it("returns enterprise URL for enterprise domain", () => {
		expect(getGitHubCopilotBaseUrl("github.enterprise.com")).toBe("https://copilot-api.github.enterprise.com");
	});
	it("preserves copilot-api prefix", () => {
		expect(getGitHubCopilotBaseUrl("copilot-api.enterprise.com")).toBe("https://copilot-api.enterprise.com");
	});
});

describe("perplexity constants", () => {
	it("PERPLEXITY_WEB_ORIGIN is correct", () => {
		expect(PERPLEXITY_WEB_ORIGIN).toBe("https://www.perplexity.ai");
	});
	it("PERPLEXITY_NATIVE_APP_BUNDLE_ID is correct", () => {
		expect(PERPLEXITY_NATIVE_APP_BUNDLE_ID).toBe("ai.perplexity.mac");
	});
	it("PERPLEXITY_NATIVE_APP_USER_AGENT is correct", () => {
		expect(PERPLEXITY_NATIVE_APP_USER_AGENT).toContain("Perplexity/");
	});
	it("PERPLEXITY_NATIVE_APP_API_VERSION is correct", () => {
		expect(PERPLEXITY_NATIVE_APP_API_VERSION).toBe("2.18");
	});
	it("PERPLEXITY_HEADERS has API_VERSION", () => {
		expect(PERPLEXITY_HEADERS.API_VERSION).toBe("X-App-ApiVersion");
	});
	it("PERPLEXITY_NATIVE_APP_HEADERS has User-Agent", () => {
		expect(PERPLEXITY_NATIVE_APP_HEADERS["User-Agent"]).toBe(PERPLEXITY_NATIVE_APP_USER_AGENT);
	});
});

describe("coreweave resolveCoreWeaveProject", () => {
	it("returns COREWEAVE_PROJECT when set", () => {
		expect(resolveCoreWeaveProject({ COREWEAVE_PROJECT: "my-project" })).toBe("my-project");
	});
	it("returns WANDB_INFERENCE_PROJECT when set", () => {
		expect(resolveCoreWeaveProject({ WANDB_INFERENCE_PROJECT: "wandb-project" })).toBe("wandb-project");
	});
	it("prefers COREWEAVE_PROJECT over WANDB_INFERENCE_PROJECT", () => {
		expect(resolveCoreWeaveProject({ COREWEAVE_PROJECT: "cw", WANDB_INFERENCE_PROJECT: "wandb" })).toBe("cw");
	});
	it("returns undefined when no project env vars", () => {
		expect(resolveCoreWeaveProject({})).toBeUndefined();
	});
	it("returns entity/project from WANDB vars", () => {
		expect(resolveCoreWeaveProject({ WANDB_ENTITY: "myteam", WANDB_PROJECT: "myproject" })).toBe("myteam/myproject");
	});
	it("returns project with slash as-is", () => {
		expect(resolveCoreWeaveProject({ WANDB_PROJECT: "team/project" })).toBe("team/project");
	});
	it("returns undefined for WANDB_PROJECT without entity", () => {
		expect(resolveCoreWeaveProject({ WANDB_PROJECT: "myproject" })).toBeUndefined();
	});
	it("trims whitespace", () => {
		expect(resolveCoreWeaveProject({ COREWEAVE_PROJECT: "  my-project  " })).toBe("my-project");
	});
	it("returns undefined for whitespace-only values", () => {
		expect(resolveCoreWeaveProject({ COREWEAVE_PROJECT: "   " })).toBeUndefined();
	});
});

describe("coreWeaveProjectHeaders", () => {
	it("returns header when project is set", () => {
		const headers = coreWeaveProjectHeaders({ COREWEAVE_PROJECT: "my-project" });
		expect(headers).toBeDefined();
		expect(headers![COREWEAVE_PROJECT_HEADER]).toBe("my-project");
	});
	it("returns undefined when no project", () => {
		expect(coreWeaveProjectHeaders({})).toBeUndefined();
	});
});

describe("hasCoreWeaveProjectHeader", () => {
	it("returns true when header is present", () => {
		expect(hasCoreWeaveProjectHeader({ "OpenAI-Project": "my-project" })).toBe(true);
	});
	it("returns true when header is present (case-insensitive)", () => {
		expect(hasCoreWeaveProjectHeader({ "openai-project": "my-project" })).toBe(true);
	});
	it("returns false when header is absent", () => {
		expect(hasCoreWeaveProjectHeader({})).toBe(false);
	});
	it("returns false when header value is blank", () => {
		expect(hasCoreWeaveProjectHeader({ "OpenAI-Project": "  " })).toBe(false);
	});
});

describe("removeBlankCoreWeaveProjectHeaders", () => {
	it("removes blank header", () => {
		const headers: Record<string, string> = { "OpenAI-Project": "  " };
		removeBlankCoreWeaveProjectHeaders(headers);
		expect(headers["OpenAI-Project"]).toBeUndefined();
	});
	it("does not remove non-blank header", () => {
		const headers: Record<string, string> = { "OpenAI-Project": "my-project" };
		removeBlankCoreWeaveProjectHeaders(headers);
		expect(headers["OpenAI-Project"]).toBe("my-project");
	});
	it("removes blank header case-insensitively", () => {
		const headers: Record<string, string> = { "openai-project": "" };
		removeBlankCoreWeaveProjectHeaders(headers);
		expect(headers["openai-project"]).toBeUndefined();
	});
	it("does not modify other headers", () => {
		const headers: Record<string, string> = { "Other-Header": "value", "OpenAI-Project": "" };
		removeBlankCoreWeaveProjectHeaders(headers);
		expect(headers["Other-Header"]).toBe("value");
	});
});

describe("google-oauth constants", () => {
	it("GOOGLE_OAUTH_AUTH_ENDPOINT is correct", () => {
		expect(GOOGLE_OAUTH_AUTH_ENDPOINT).toBe("https://accounts.google.com/o/oauth2/v2/auth");
	});
	it("GOOGLE_OAUTH_TOKEN_ENDPOINT is correct", () => {
		expect(GOOGLE_OAUTH_TOKEN_ENDPOINT).toBe("https://oauth2.googleapis.com/token");
	});
	it("GOOGLE_SCOPE_CLOUD_PLATFORM is correct", () => {
		expect(GOOGLE_SCOPE_CLOUD_PLATFORM).toBe("https://www.googleapis.com/auth/cloud-platform");
	});
	it("GOOGLE_BASE_OAUTH_SCOPES has 3 scopes", () => {
		expect(GOOGLE_BASE_OAUTH_SCOPES).toHaveLength(3);
	});
	it("GOOGLE_BASE_OAUTH_SCOPES includes cloud-platform", () => {
		expect(GOOGLE_BASE_OAUTH_SCOPES).toContain(GOOGLE_SCOPE_CLOUD_PLATFORM);
	});
});
