import { describe, expect, it } from "bun:test";
import {
	ANTHROPIC_API_ENDPOINT,
	ANTIGRAVITY_ENDPOINTS,
	ANTIGRAVITY_PRIMARY_ENDPOINT,
	ANTIGRAVITY_SANDBOX_ENDPOINT,
	CLOUD_CODE_ENDPOINT,
	CURSOR_API_ENDPOINT,
	DEVIN_AUTH_ENDPOINT,
	DEVIN_CASCADE_ENDPOINT,
	DEVIN_WEBAPP_URL,
	GEMINI_DEVELOPER_API_ENDPOINT,
	GITLAB_SAAS_URL,
	OPENROUTER_API_ENDPOINT,
} from "../src/provider-endpoints";

describe("provider endpoint constants", () => {
	it("CLOUD_CODE_ENDPOINT is Google cloudcode", () => {
		expect(CLOUD_CODE_ENDPOINT).toBe("https://cloudcode-pa.googleapis.com");
	});

	it("ANTIGRAVITY_PRIMARY_ENDPOINT is daily cloudcode", () => {
		expect(ANTIGRAVITY_PRIMARY_ENDPOINT).toBe("https://daily-cloudcode-pa.googleapis.com");
	});

	it("ANTIGRAVITY_SANDBOX_ENDPOINT is daily cloudcode sandbox", () => {
		expect(ANTIGRAVITY_SANDBOX_ENDPOINT).toBe("https://daily-cloudcode-pa.sandbox.googleapis.com");
	});

	it("ANTIGRAVITY_ENDPOINTS contains both endpoints", () => {
		expect(ANTIGRAVITY_ENDPOINTS).toHaveLength(2);
		expect(ANTIGRAVITY_ENDPOINTS).toContain(ANTIGRAVITY_PRIMARY_ENDPOINT);
		expect(ANTIGRAVITY_ENDPOINTS).toContain(ANTIGRAVITY_SANDBOX_ENDPOINT);
	});

	it("GITLAB_SAAS_URL is gitlab.com", () => {
		expect(GITLAB_SAAS_URL).toBe("https://gitlab.com");
	});

	it("DEVIN_CASCADE_ENDPOINT is codeium server", () => {
		expect(DEVIN_CASCADE_ENDPOINT).toBe("https://server.codeium.com");
	});

	it("DEVIN_AUTH_ENDPOINT is api.devin.ai", () => {
		expect(DEVIN_AUTH_ENDPOINT).toBe("https://api.devin.ai");
	});

	it("DEVIN_WEBAPP_URL is app.devin.ai", () => {
		expect(DEVIN_WEBAPP_URL).toBe("https://app.devin.ai");
	});

	it("GEMINI_DEVELOPER_API_ENDPOINT is generativelanguage", () => {
		expect(GEMINI_DEVELOPER_API_ENDPOINT).toBe("https://generativelanguage.googleapis.com/v1beta");
	});

	it("ANTHROPIC_API_ENDPOINT is api.anthropic.com", () => {
		expect(ANTHROPIC_API_ENDPOINT).toBe("https://api.anthropic.com");
	});

	it("CURSOR_API_ENDPOINT is api2.cursor.sh", () => {
		expect(CURSOR_API_ENDPOINT).toBe("https://api2.cursor.sh");
	});

	it("OPENROUTER_API_ENDPOINT is openrouter.ai", () => {
		expect(OPENROUTER_API_ENDPOINT).toBe("https://openrouter.ai/api/v1");
	});

	it("all endpoints are HTTPS", () => {
		const endpoints = [
			CLOUD_CODE_ENDPOINT,
			ANTIGRAVITY_PRIMARY_ENDPOINT,
			ANTIGRAVITY_SANDBOX_ENDPOINT,
			GITLAB_SAAS_URL,
			DEVIN_CASCADE_ENDPOINT,
			DEVIN_AUTH_ENDPOINT,
			DEVIN_WEBAPP_URL,
			GEMINI_DEVELOPER_API_ENDPOINT,
			ANTHROPIC_API_ENDPOINT,
			CURSOR_API_ENDPOINT,
			OPENROUTER_API_ENDPOINT,
		];
		for (const url of endpoints) {
			expect(url.startsWith("https://")).toBe(true);
		}
	});
});
