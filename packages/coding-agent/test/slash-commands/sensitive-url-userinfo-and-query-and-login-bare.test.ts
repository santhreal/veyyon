/**
 * credential-bearing-commands-never-persist already pins user:pass@host on
 * /mcp add, ?api_key= / ?token=, a userinfo-less URL as recallable, /login
 * bare vs /login anthropic. Gaps: empty password, user@host with no colon,
 * email without `//`, `;token=` as a scanner separator, substring names,
 * whitespace-only `/login` tail, and trimStart of a leading-space invocation.
 */
import { describe, expect, it } from "bun:test";
import { isSensitiveSlashCommand } from "@veyyon/coding-agent/slash-commands/helpers/parse";

describe("userinfo shapes the persist suite does not name", () => {
	it("classifies user:@host and user@host, but not an email without //", () => {
		expect(isSensitiveSlashCommand("/run http://alice:@example.com")).toBe(true);
		expect(isSensitiveSlashCommand("/run http://alice@example.com")).toBe(true);
		expect(isSensitiveSlashCommand("/note alice@example.com wrote this")).toBe(false);
	});
});

describe("query scanner separators and substring names", () => {
	it("classifies ;token= as a scanner separator and api_key_id= as a substring hit", () => {
		expect(isSensitiveSlashCommand("/open https://x.example/?page=1;token=abcd")).toBe(true);
		expect(isSensitiveSlashCommand("/open https://x.example/?api_key_id=1")).toBe(true);
	});
});

describe("/login whitespace is not an argument tail", () => {
	it("does not treat a trailing space or tab on /login as a tail", () => {
		expect(isSensitiveSlashCommand("/login ")).toBe(false);
		expect(isSensitiveSlashCommand("/join\t")).toBe(false);
	});

	it("trimStarts a leading-space invocation before deciding /login vs /login anthropic", () => {
		expect(isSensitiveSlashCommand("  /login anthropic")).toBe(true);
		expect(isSensitiveSlashCommand("  /login")).toBe(false);
	});
});
