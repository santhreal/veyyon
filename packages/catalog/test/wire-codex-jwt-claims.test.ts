/**
 * ONE-PLACE lock for the Codex JWT claim namespaces and the parser that reads them.
 *
 * Why this suite exists: five modules across three packages each hand-rolled "decode a ChatGPT OAuth token and
 * pull the account id out of it". `wire/codex.ts` had `JWT_CLAIM_PATH` and `getCodexAccountId`;
 * `ai/registry/oauth/openai-codex.ts` had `JWT_CLAIM_PATH` again with its own extractor;
 * `ai/usage/openai-codex.ts` had the same URI under a third name, `JWT_AUTH_CLAIM`;
 * `coding-agent/web/search/providers/codex.ts` had a fourth copy while ALREADY importing three other constants
 * from the owner in the same import statement; and `ai/auth-credential-rows.ts` spelled both URIs as bare
 * literals, which is the copy a grep for any of the three constant names never finds.
 *
 * A claim namespace is a lookup KEY, so a drift does not throw. The index returns `undefined`, the account id
 * comes back absent, and a valid token is treated as one that carries no account: downstream that reads as "not
 * signed in to ChatGPT" rather than as a bug.
 *
 * The four copies also disagreed about an empty claim, and one of them was wrong. `ai/usage/openai-codex.ts`
 * returned `""` unchanged, and that value becomes the `chatgpt-account-id` request header, where an empty value
 * makes the backend answer a malformed-account error instead of falling back to the token's own account. The two
 * guarded copies were right and the owner now states the rule once.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	CODEX_JWT_AUTH_CLAIM,
	CODEX_JWT_PROFILE_CLAIM,
	getCodexAccountEmail,
	getCodexAccountId,
	JWT_CLAIM_PATH,
	readCodexClaimsFromPayload,
	readCodexTokenIdentity,
} from "../src/wire/codex";

/** Build a JWT with the given payload. The signature is never checked by these readers, only the payload. */
function tokenFor(payload: Record<string, unknown>): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=+$/, "");
	return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

const ACCOUNT = "acct_2f9c41d0-7b6e-4c11-9a05-3d81e6f0aa12";

describe("the Codex JWT claim namespaces", () => {
	/**
	 * The auth claim, pinned as exact bytes. OpenAI namespaces private claims by URI, so these bytes ARE the key
	 * the payload is indexed by: one character off and every account id in the tree reads as absent.
	 */
	it("names the auth claim by its exact URI", () => {
		expect(CODEX_JWT_AUTH_CLAIM).toBe("https://api.openai.com/auth");
	});

	/** The profile claim, which is where the email lives and not the account id. */
	it("names the profile claim by its exact URI", () => {
		expect(CODEX_JWT_PROFILE_CLAIM).toBe("https://api.openai.com/profile");
	});

	/**
	 * The two URIs differ by one path segment, which is exactly why they were worth putting side by side. Reading
	 * the account id out of the profile claim, or the email out of the auth claim, yields `undefined` in both
	 * directions with nothing logged.
	 */
	it("keeps the two claims distinct but on one host", () => {
		expect(CODEX_JWT_AUTH_CLAIM).not.toBe(CODEX_JWT_PROFILE_CLAIM);
		expect(new URL(CODEX_JWT_AUTH_CLAIM).origin).toBe(new URL(CODEX_JWT_PROFILE_CLAIM).origin);
		// The whole URI, literal: this is the key OpenAI writes into the token, so a
		// change to the origin makes every Codex identity read fail while the
		// pathname assertion alone stays green.
		expect(CODEX_JWT_AUTH_CLAIM).toBe("https://api.openai.com/auth");
		expect(new URL(CODEX_JWT_AUTH_CLAIM).pathname).toBe("/auth");
		expect(new URL(CODEX_JWT_PROFILE_CLAIM).pathname).toBe("/profile");
	});

	/**
	 * The retired public name is an alias of the same value rather than a second declaration, because this
	 * module's exports are published surface. Asserted so the two cannot drift into meaning different URIs.
	 */
	it("keeps the retired name pointing at the same value", () => {
		expect(JWT_CLAIM_PATH).toBe(CODEX_JWT_AUTH_CLAIM);
	});
});

describe("reading a Codex token's identity", () => {
	/** The ordinary case: both claims present, both read. */
	it("reads the account id and the email from a full token", () => {
		const identity = readCodexTokenIdentity(
			tokenFor({
				[CODEX_JWT_AUTH_CLAIM]: { chatgpt_account_id: ACCOUNT },
				[CODEX_JWT_PROFILE_CLAIM]: { email: "person@example.com" },
			}),
		);
		expect(identity).toEqual({ accountId: ACCOUNT, email: "person@example.com" });
	});

	/**
	 * The email is lowercased, because it is used to MATCH a stored credential to an account and the provider
	 * echoes back whatever case the user typed at sign-in. Two credentials for one account would otherwise look
	 * like two accounts.
	 */
	it("lowercases the email", () => {
		expect(getCodexAccountEmail(tokenFor({ [CODEX_JWT_PROFILE_CLAIM]: { email: "Person@Example.COM" } }))).toBe(
			"person@example.com",
		);
	});

	/** Surrounding whitespace in a claim is trimmed rather than carried into a header or an identity key. */
	it("trims a padded claim", () => {
		const identity = readCodexTokenIdentity(
			tokenFor({
				[CODEX_JWT_AUTH_CLAIM]: { chatgpt_account_id: `  ${ACCOUNT}\n` },
				[CODEX_JWT_PROFILE_CLAIM]: { email: " person@example.com " },
			}),
		);
		expect(identity).toEqual({ accountId: ACCOUNT, email: "person@example.com" });
	});

	/**
	 * THE BUG ONE OF THE FOUR COPIES HAD. An empty account claim is reported as absent, not passed through as
	 * `""`. `chatgpt_account_id` becomes the `chatgpt-account-id` header, and an empty header value makes the
	 * backend answer a malformed-account error rather than using the token's own account, so `""` is strictly
	 * worse than omitting the header. `ai/usage/openai-codex.ts` returned it unchanged.
	 */
	it("treats an empty account claim as absent", () => {
		for (const value of ["", "   ", "\t\n"]) {
			expect(
				getCodexAccountId(tokenFor({ [CODEX_JWT_AUTH_CLAIM]: { chatgpt_account_id: value } })),
				JSON.stringify(value),
			).toBeUndefined();
		}
	});

	/** Same rule for the email, since an empty identity key would match every credential that also has none. */
	it("treats an empty email claim as absent", () => {
		expect(getCodexAccountEmail(tokenFor({ [CODEX_JWT_PROFILE_CLAIM]: { email: "  " } }))).toBeUndefined();
	});

	/** A claim of the wrong TYPE is absent too: a number or an object where a string belongs is not an account. */
	it("treats a non-string claim as absent", () => {
		for (const value of [42, true, null, {}, []]) {
			expect(
				getCodexAccountId(tokenFor({ [CODEX_JWT_AUTH_CLAIM]: { chatgpt_account_id: value } })),
				JSON.stringify(value),
			).toBeUndefined();
		}
	});

	/** A claim namespace present but not an object, which a proxy that rewrites tokens can produce. */
	it("survives a claim namespace that is not an object", () => {
		for (const value of ["a string", 7, null]) {
			expect(readCodexTokenIdentity(tokenFor({ [CODEX_JWT_AUTH_CLAIM]: value }))).toEqual({
				accountId: undefined,
				email: undefined,
			});
		}
	});

	/**
	 * A token from a different provider decodes fine and simply carries neither claim. Worth pinning because the
	 * same auth storage holds credentials for every provider, and this reader is handed whatever is stored.
	 */
	it("reports nothing for a token that is not a Codex token", () => {
		const identity = readCodexTokenIdentity(tokenFor({ sub: "user_123", iss: "https://auth.example.com" }));
		expect(identity.accountId).toBeUndefined();
		expect(identity.email).toBeUndefined();
	});

	/**
	 * Missing, malformed and undecodable tokens are all reported as an empty identity rather than thrown, because
	 * no call site can distinguish them from "carries no account claim" and every one of the four copies this
	 * replaces treated them the same way.
	 */
	it("reports an empty identity for a token it cannot decode", () => {
		for (const token of [undefined, "", "not-a-jwt", "a.b", "a.b.c", "...", "e30.e30"]) {
			expect(readCodexTokenIdentity(token), JSON.stringify(token)).toEqual({});
		}
	});

	/** The payload-level entry point agrees with the token-level one, since one calls the other. */
	it("agrees between the payload and token entry points", () => {
		const payload = {
			[CODEX_JWT_AUTH_CLAIM]: { chatgpt_account_id: ACCOUNT },
			[CODEX_JWT_PROFILE_CLAIM]: { email: "Person@Example.com" },
		};
		expect(readCodexClaimsFromPayload(payload)).toEqual(readCodexTokenIdentity(tokenFor(payload)));
	});

	/**
	 * The payload entry point exists so a caller that already decoded a token is not made to decode it twice.
	 * `ai/auth-credential-rows.ts` is that caller: it reads several identifiers out of one payload.
	 */
	it("reads claims out of an already-decoded payload", () => {
		expect(readCodexClaimsFromPayload({ [CODEX_JWT_AUTH_CLAIM]: { chatgpt_account_id: ACCOUNT } })).toEqual({
			accountId: ACCOUNT,
			email: undefined,
		});
		expect(readCodexClaimsFromPayload({})).toEqual({ accountId: undefined, email: undefined });
	});
});

describe("the Codex claim namespaces have one owner", () => {
	const PACKAGE_SOURCES = ["../../ai/src", "../../catalog/src", "../../coding-agent/src"] as const;
	const OWNER = path.resolve(import.meta.dir, "../src/wire/codex.ts");

	async function sources(): Promise<ReadonlyArray<{ file: string; text: string }>> {
		const collected: Array<{ file: string; text: string }> = [];
		for (const relative of PACKAGE_SOURCES) {
			const root = path.resolve(import.meta.dir, relative);
			for (const file of new Bun.Glob("**/*.ts").scanSync(root)) {
				const full = path.join(root, file);
				if (full === OWNER) continue;
				if (file.includes("__tests__")) continue;
				collected.push({ file: `${relative}/${file}`, text: await Bun.file(full).text() });
			}
		}
		return collected;
	}

	/**
	 * The ratchet, keyed on the LITERAL and not on a name, because the four copies used four different names and
	 * one of them was a bare literal with no name at all. Anything that spells either URI outside the owner is a
	 * fifth copy, whatever it calls itself.
	 */
	it("spells neither claim URI outside the owner", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await sources()) {
			for (const claim of [CODEX_JWT_AUTH_CLAIM, CODEX_JWT_PROFILE_CLAIM]) {
				if (text.includes(`"${claim}"`)) offenders.push(`${file} spells ${claim}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/** Nor declares one of the names the copies used, whatever value it were given. */
	it("declares none of the retired names", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await sources()) {
			for (const name of ["JWT_CLAIM_PATH", "JWT_AUTH_CLAIM", "JWT_PROFILE_CLAIM"]) {
				if (new RegExp(`^\\s*(?:export )?const ${name}\\b`, "m").test(text)) offenders.push(`${file}: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The non-vacuity twin. Both ratchets pass over an empty scan, so require that it reaches all three package
	 * trees and every module that held a copy.
	 */
	it("scans all three packages including every former declarer", async () => {
		const files = (await sources()).map(entry => entry.file);
		expect(files.length).toBeGreaterThan(500);
		for (const declarer of [
			"../../ai/src/registry/oauth/openai-codex.ts",
			"../../ai/src/usage/openai-codex.ts",
			"../../ai/src/auth-credential-rows.ts",
			"../../coding-agent/src/web/search/providers/codex.ts",
		]) {
			expect(files).toContain(declarer);
		}
	});

	/** The positive half: each former declarer now reads the claims through the owner. */
	it("has every former declarer importing the owner's reader", async () => {
		const expected: ReadonlyArray<[string, string]> = [
			["../../ai/src/registry/oauth/openai-codex.ts", "readCodexTokenIdentity"],
			["../../ai/src/usage/openai-codex.ts", "getCodexAccountId"],
			["../../ai/src/auth-credential-rows.ts", "readCodexClaimsFromPayload"],
			["../../coding-agent/src/web/search/providers/codex.ts", "getCodexAccountId"],
		];
		for (const [relative, symbol] of expected) {
			const text = await Bun.file(path.resolve(import.meta.dir, relative)).text();
			expect(text, relative).toContain(symbol);
			expect(text, relative).toMatch(/from "(?:@veyyon\/catalog\/wire\/codex|\.\.\/wire\/codex)";/);
		}
	});

	/**
	 * The claim lives beside the HEADER the account id is sent under, which is the other half of the contract and
	 * the reason this module is the right owner rather than a new leaf: a reader that changes one wants to see the
	 * other.
	 */
	it("keeps the claim beside the header it feeds", async () => {
		const owner = await Bun.file(OWNER).text();
		expect(owner).toContain('ACCOUNT_ID: "chatgpt-account-id"');
		expect(owner).toContain("export const CODEX_JWT_AUTH_CLAIM");
	});

	/**
	 * The tree has one JWT decoder, `decodeJwtPayload` in `@veyyon/utils`. `ai/registry/oauth/openai-codex.ts`
	 * used to export a deprecated `decodeJwt` that only forwarded to it, and its last caller was the search
	 * provider fixed here, so it published a second name for one parser. Removed, and pinned so it does not
	 * return.
	 */
	it("publishes no second name for the JWT decoder", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await sources()) {
			if (/^\s*export function decodeJwt\b/m.test(text)) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});
