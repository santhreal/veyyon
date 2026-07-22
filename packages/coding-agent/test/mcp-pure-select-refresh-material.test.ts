/**
 * selectMcpOAuthRefreshMaterial prefers credential with tokenUrl.
 */
import { describe, expect, it } from "bun:test";
import { selectMcpOAuthRefreshMaterial } from "../src/mcp/oauth-credentials";

describe("selectMcpOAuthRefreshMaterial", () => {
	it("prefers credential when tokenUrl present", () => {
		const cred = { type: "oauth" as const, access: "a", refresh: "r", expires: 0, tokenUrl: "https://t" };
		const auth = { type: "oauth" as const, tokenUrl: "https://other" };
		expect(selectMcpOAuthRefreshMaterial(cred as never, auth)).toBe(cred);
	});

	it("falls back to auth when credential has no tokenUrl", () => {
		const cred = { type: "oauth" as const, access: "a", refresh: "r", expires: 0 };
		const auth = { type: "oauth" as const, tokenUrl: "https://other" };
		expect(selectMcpOAuthRefreshMaterial(cred as never, auth)).toBe(auth);
	});

	it("undefined auth when no tokenUrl on credential", () => {
		const cred = { type: "oauth" as const, access: "a", refresh: "r", expires: 0 };
		expect(selectMcpOAuthRefreshMaterial(cred as never, undefined)).toBeUndefined();
	});
});
