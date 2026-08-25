/**
 * isSensitiveSlashCommand is the durable-history gate: a true here means the
 * submitted line never becomes recallable editor history or a resumable draft.
 *
 * WHY THIS SUITE EXISTS. The persist suite pins option names (`--token`,
 * `-t`, `-H`), `/secret`, misspelled `tokn` on `/mcp add`, and a credential
 * URL on `/mcp add`. It does not pin the three recognisers separately:
 *
 *   1. USERINFO. `scheme://user:pass@host` is sensitive on ANY command.
 *      A userinfo-less URL must stay false. `alice@example.com` without
 *      `//` is not userinfo.
 *
 *   2. QUERY PARAM NAMES. `?api_key=` matches CREDENTIAL_QUERY_PARAM_RE.
 *      `?page=` does not.
 *
 *   3. `/login` and `/join` are sensitive ONLY when there is more than
 *      `/name`. Bare `/login` is a UI command and MUST remain recallable.
 *      A whitespace-only tail is not a tail.
 */
import { describe, expect, it } from "bun:test";
import { isSensitiveSlashCommand } from "@veyyon/coding-agent/slash-commands/helpers/parse";

describe("userinfo in a URL is sensitive; a plain URL is not", () => {
	it("classifies scheme://user:pass@host on an ordinary command", () => {
		expect(isSensitiveSlashCommand("/mcp add srv url http://alice:secret@example.com")).toBe(true);
		expect(isSensitiveSlashCommand("/foo http://alice:secret@example.com/x")).toBe(true);
		expect(isSensitiveSlashCommand("/ssh add box host://user:pass@10.0.0.1")).toBe(true);
	});

	it("does not classify a URL with no userinfo as sensitive just because it is a URL", () => {
		expect(isSensitiveSlashCommand("/mcp add srv url http://example.com")).toBe(false);
		expect(isSensitiveSlashCommand("/mcp add srv url https://example.com/v1")).toBe(false);
		expect(isSensitiveSlashCommand("/open https://github.com/org/repo")).toBe(false);
	});

	it("classifies userinfo even when the password is empty (user:@host)", () => {
		expect(isSensitiveSlashCommand("/run http://alice:@example.com")).toBe(true);
	});

	it("classifies userinfo with only a user and no colon as still userinfo (`user@host`)", () => {
		expect(isSensitiveSlashCommand("/run http://alice@example.com")).toBe(true);
	});

	it("does not treat an email-like token without // as userinfo", () => {
		expect(isSensitiveSlashCommand("/note alice@example.com wrote this")).toBe(false);
	});
});

describe("query parameter NAMES that look like credentials are sensitive", () => {
	it("classifies ?api_key= and ?token= and ?password= and ?secret= and ?auth= and ?credential=", () => {
		expect(isSensitiveSlashCommand("/open https://x.example/?api_key=abcd")).toBe(true);
		expect(isSensitiveSlashCommand("/open https://x.example/?token=abcd")).toBe(true);
		expect(isSensitiveSlashCommand("/open https://x.example/?password=abcd")).toBe(true);
		expect(isSensitiveSlashCommand("/open https://x.example/?secret=abcd")).toBe(true);
		expect(isSensitiveSlashCommand("/open https://x.example/?auth=abcd")).toBe(true);
		expect(isSensitiveSlashCommand("/open https://x.example/?credential=abcd")).toBe(true);
	});

	it("classifies &token= in a later query pair, and ;token= as a scanner separator", () => {
		expect(isSensitiveSlashCommand("/open https://x.example/?page=1&token=abcd")).toBe(true);
		expect(isSensitiveSlashCommand("/open https://x.example/?page=1;token=abcd")).toBe(true);
	});

	it("classifies a compound name like api_key_id= because the pattern is a substring of the name", () => {
		expect(isSensitiveSlashCommand("/open https://x.example/?api_key_id=1")).toBe(true);
	});

	it("does not classify ?page= or ?q= or ?offset= as credential query params", () => {
		expect(isSensitiveSlashCommand("/open https://x.example/?page=1")).toBe(false);
		expect(isSensitiveSlashCommand("/open https://x.example/?q=foo")).toBe(false);
		expect(isSensitiveSlashCommand("/open https://x.example/?offset=10&limit=10")).toBe(false);
	});

	it("is case-insensitive on the credential-shaped query name", () => {
		expect(isSensitiveSlashCommand("/open https://x.example/?API_KEY=abcd")).toBe(true);
		expect(isSensitiveSlashCommand("/open https://x.example/?Token=abcd")).toBe(true);
	});
});

describe("/login and /join are sensitive only with an argument tail", () => {
	it("leaves bare /login and /join recallable", () => {
		expect(isSensitiveSlashCommand("/login")).toBe(false);
		expect(isSensitiveSlashCommand("/join")).toBe(false);
	});

	it("does not treat a trailing space on /login as an argument tail", () => {
		// parseSlashCommand keeps the original text; `text.length > name.length + 1`
		// is true for `/login ` even though args are empty after trimStart of the
		// slice. A stray space then makes a recallable UI command durable-history
		// sensitive. Pin the operator contract: whitespace-only tail is not a tail.
		expect(isSensitiveSlashCommand("/login ")).toBe(false);
		expect(isSensitiveSlashCommand("/join\t")).toBe(false);
	});

	it("classifies /login anthropic and /join room as sensitive even when the tail is not a secret", () => {
		expect(isSensitiveSlashCommand("/login anthropic")).toBe(true);
		expect(isSensitiveSlashCommand("/join room")).toBe(true);
		expect(isSensitiveSlashCommand("/login:anthropic")).toBe(true);
	});

	it("classifies a leading-whitespace /login with a tail after trimStart inside the predicate", () => {
		expect(isSensitiveSlashCommand("  /login anthropic")).toBe(true);
		expect(isSensitiveSlashCommand("  /login")).toBe(false);
	});
});
