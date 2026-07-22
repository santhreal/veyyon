/**
 * redactUrlForLog matrix: sensitive keys redacted, others kept.
 */
import { describe, expect, it } from "bun:test";
import { redactUrlForLog } from "../src/mcp/json-rpc";

describe("redactUrlForLog matrix", () => {
	const keys = ["key", "token", "secret", "auth", "apiKey", "exaApiKey", "client_secret", "TOKEN"];
	for (const key of keys) {
		it(`redacts ${key}`, () => {
			const out = redactUrlForLog(`https://ex.test/mcp?${key}=LEAK&q=1`);
			expect(out).not.toContain("LEAK");
			expect(out.includes("%5Bredacted%5D") || out.includes("[redacted]")).toBe(true);
			expect(out).toContain("q=1");
		});
	}

	it("safe query kept", () => {
		const out = redactUrlForLog("https://ex.test/mcp?page=1&limit=10");
		expect(out).toContain("page=1");
		expect(out).toContain("limit=10");
		expect(out).not.toContain("redacted");
	});

	it("unparseable drops query", () => {
		expect(redactUrlForLog("not-a-url?token=secret")).toBe("not-a-url");
	});
});
