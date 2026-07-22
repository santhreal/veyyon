/**
 * hasMcpAuthorizationHeader matrix across transport types and header casings.
 */
import { describe, expect, it } from "bun:test";
import { hasMcpAuthorizationHeader } from "../src/mcp/oauth-credentials";

describe("hasMcpAuthorizationHeader matrix", () => {
	it("stdio always false", () => {
		expect(hasMcpAuthorizationHeader({ command: "npx" })).toBe(false);
		expect(hasMcpAuthorizationHeader({ command: "npx", type: "stdio" } as never)).toBe(false);
	});

	it("http without headers false", () => {
		expect(hasMcpAuthorizationHeader({ type: "http", url: "https://x" })).toBe(false);
		expect(hasMcpAuthorizationHeader({ type: "http", url: "https://x", headers: {} })).toBe(false);
	});

	it("Authorization header casings", () => {
		for (const key of ["Authorization", "authorization", "AUTHORIZATION", "AuThOrIzAtIoN"]) {
			expect(
				hasMcpAuthorizationHeader({
					type: "http",
					url: "https://x",
					headers: { [key]: "Bearer t" },
				}),
			).toBe(true);
		}
	});

	it("other headers do not count", () => {
		expect(
			hasMcpAuthorizationHeader({
				type: "http",
				url: "https://x",
				headers: { "X-Api-Key": "k", Accept: "application/json" },
			}),
		).toBe(false);
	});

	it("sse same as http", () => {
		expect(
			hasMcpAuthorizationHeader({
				type: "sse",
				url: "https://x",
				headers: { authorization: "Bearer t" },
			}),
		).toBe(true);
	});
});
