/**
 * A new OAuth login either replaces the stored row of the same subscription or adds a row beside
 * it. Replacing the wrong row loses a subscription the user still holds; adding a row for the same
 * subscription duplicates it, splitting its usage and rotation across two copies.
 *
 * The first suite stores every combination of email, account, project and org identity, then logs
 * in with every combination, through `SqliteAuthCredentialStore`, for an org-scoped provider
 * (`anthropic`), the email-first provider (`openai-codex`) and a provider with neither rule. The
 * oracle states the rule from its documented parts: equal identity keys replace, and an org-scoped
 * login also claims the org-only row, a row keyed by one of its bases bare or under its org, and a
 * same-org row whose stored credential shares one of its bases. An org-less login never claims an
 * org-scoped row.
 *
 * A row's key is the `identity_key` column written beside it, not a key recomputed from its stored
 * credential: a row keyed by an earlier release can name a base its credential no longer yields. The
 * second sweep pairs every distinct anthropic key with every stored credential and every login, so a
 * login is held to the row's column key and, separately, to the credential's identifiers.
 *
 * The last suite places each identity in each JWT claim a token can carry it in and checks the
 * key the stored row is written with, including the order the claims are read in.
 *
 * Not caught: identity values that differ only in Unicode case folding beyond `toLowerCase`, and the
 * order rows are returned in.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { extractOAuthTokenIdentifiers, serializeCredential } from "@veyyon/ai/auth-credential-rows";
import { type AuthCredential, type OAuthCredential, SqliteAuthCredentialStore } from "@veyyon/ai/auth-storage";

interface Identity {
	email?: string;
	account?: string;
	project?: string;
	org?: string;
}

const EMAILS = [undefined, "one@example.com", "two@example.com"];
const ACCOUNTS = [undefined, "acct-1", "acct-2"];
const PROJECTS = [undefined, "proj-1"];
const ORGS = [undefined, "org-1", "org-2"];
const PROVIDERS = ["anthropic", "openai-codex", "github-copilot"];

const IDENTITIES: Identity[] = EMAILS.flatMap(email =>
	ACCOUNTS.flatMap(account =>
		PROJECTS.flatMap(project => ORGS.map(org => ({ email, account, project, org }) satisfies Identity)),
	),
);

function oauthCredential(identity: Identity, marker: string): AuthCredential {
	return {
		type: "oauth",
		access: `access-${marker}`,
		refresh: `refresh-${marker}`,
		expires: 0,
		email: identity.email,
		accountId: identity.account,
		projectId: identity.project,
		orgId: identity.org,
	};
}

function bases(identity: Identity): string[] {
	const result: string[] = [];
	if (identity.email) result.push(`email:${identity.email}`);
	if (identity.account) result.push(`account:${identity.account}`);
	if (identity.project) result.push(`project:${identity.project}`);
	return result;
}

function expectedKey(provider: string, identity: Identity): string | null {
	const email = identity.email ? `email:${identity.email}` : undefined;
	const account = identity.account ? `account:${identity.account}` : undefined;
	const project = identity.project ? `project:${identity.project}` : undefined;
	if (provider === "anthropic") {
		const org = identity.org ? `org:${identity.org}` : undefined;
		const base = email ?? account ?? project;
		if (base) return org ? `${base}|${org}` : base;
		return org ?? null;
	}
	if (provider === "openai-codex" && email) return email;
	return account ?? email ?? project ?? null;
}

function replaces(
	provider: string,
	stored: Identity,
	login: Identity,
	storedKey: string | null = expectedKey(provider, stored),
): boolean {
	const loginKey = expectedKey(provider, login);
	if (loginKey === null) return false;
	if (loginKey === storedKey) return true;
	if (storedKey === null || provider !== "anthropic" || !login.org) return false;
	const org = `org:${login.org}`;
	if (storedKey === org) return true;
	const loginBases = bases(login);
	if (loginBases.some(base => storedKey === base || storedKey === `${base}|${org}`)) return true;
	const storedBases = bases(stored);
	return storedKey.endsWith(`|${org}`) && loginBases.some(base => storedBases.includes(base));
}

function describeIdentity(identity: Identity): string {
	return JSON.stringify(identity);
}

describe("a login replaces the stored row of its own subscription only", () => {
	for (const provider of PROVIDERS) {
		it(`holds for every stored and logged-in identity on ${provider}`, () => {
			const store = new SqliteAuthCredentialStore(new Database(":memory:"));
			const mismatches: string[] = [];
			let replaced = 0;
			try {
				for (const stored of IDENTITIES) {
					for (const login of IDENTITIES) {
						store.replaceAuthCredentialsForProvider(provider, [oauthCredential(stored, "stored")]);
						const rows = store.upsertAuthCredentialForProvider(provider, oauthCredential(login, "login"));
						const accesses = rows
							.map(row => (row.credential.type === "oauth" ? row.credential.access : row.credential.key))
							.sort();
						const expectReplace = replaces(provider, stored, login);
						if (expectReplace) replaced += 1;
						const expected = expectReplace ? ["access-login"] : ["access-login", "access-stored"];
						if (JSON.stringify(accesses) !== JSON.stringify(expected)) {
							mismatches.push(
								`stored ${describeIdentity(stored)} login ${describeIdentity(login)}: ${accesses.join(",")}`,
							);
						}
					}
				}
			} finally {
				store.close();
			}
			expect(mismatches.slice(0, 10)).toEqual([]);
			// Both outcomes occur for every provider, so a store that always replaces or never does fails.
			expect(replaced).toBeGreaterThan(IDENTITIES.length);
			expect(replaced).toBeLessThan(IDENTITIES.length * IDENTITIES.length);
		});
	}

	it("re-keys the claimed row to the login's identity", () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		try {
			store.replaceAuthCredentialsForProvider("anthropic", [
				oauthCredential({ account: "acct-1", org: "org-1" }, "stored"),
			]);
			const [row, ...rest] = store.upsertAuthCredentialForProvider(
				"anthropic",
				oauthCredential({ email: "one@example.com", account: "acct-1", org: "org-1" }, "login"),
			);
			expect(rest).toEqual([]);
			if (row?.credential.type !== "oauth") throw new Error("expected the claimed oauth row");
			expect(serializeCredential("anthropic", row.credential)?.identityKey).toBe("email:one@example.com|org:org-1");
		} finally {
			store.close();
		}
	});

	it("holds when the row's stored key names a base its stored credential no longer carries", () => {
		const db = new Database(":memory:");
		const store = new SqliteAuthCredentialStore(db);
		// Each case starts from an empty table; replaced rows otherwise accumulate as disabled rows every write rescans.
		const clear = db.prepare("DELETE FROM auth_credentials");
		const rekey = db.prepare(
			"UPDATE auth_credentials SET identity_key = ? WHERE provider = 'anthropic' AND disabled_cause IS NULL",
		);
		const keys = [...new Set(IDENTITIES.map(identity => expectedKey("anthropic", identity)))].filter(
			(key): key is string => key !== null,
		);
		const mismatches: string[] = [];
		let claimedByKeyOnly = 0;
		try {
			for (const storedKey of keys) {
				for (const stored of IDENTITIES) {
					for (const login of IDENTITIES) {
						clear.run();
						store.replaceAuthCredentialsForProvider("anthropic", [oauthCredential(stored, "stored")]);
						rekey.run(storedKey);
						const rows = store.upsertAuthCredentialForProvider("anthropic", oauthCredential(login, "login"));
						const accesses = rows
							.map(row => (row.credential.type === "oauth" ? row.credential.access : row.credential.key))
							.sort();
						const expectReplace = replaces("anthropic", stored, login, storedKey);
						if (expectReplace && !replaces("anthropic", stored, login)) claimedByKeyOnly += 1;
						const expected = expectReplace ? ["access-login"] : ["access-login", "access-stored"];
						if (JSON.stringify(accesses) !== JSON.stringify(expected)) {
							mismatches.push(
								`key ${storedKey} stored ${describeIdentity(stored)} login ${describeIdentity(login)}: ${accesses.join(",")}`,
							);
						}
					}
				}
			}
		} finally {
			clear.finalize();
			rekey.finalize();
			store.close();
		}
		expect(mismatches.slice(0, 10)).toEqual([]);
		// The column key decides some claims the stored credential alone would not, so a matcher that reads only
		// the credential's identifiers fails.
		expect(claimedByKeyOnly).toBeGreaterThan(0);
	});
});

function jwt(claims: Record<string, unknown>): string {
	return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";
const CODEX_PROFILE_CLAIM = "https://api.openai.com/profile";

/** Each account claim a token can carry, in the order the identity is read from them. */
const ACCOUNT_CLAIMS: Array<[string, (value: string) => Record<string, unknown>]> = [
	["account_id", value => ({ account_id: value })],
	["accountId", value => ({ accountId: value })],
	["user_id", value => ({ user_id: value })],
	["sub", value => ({ sub: value })],
	[CODEX_AUTH_CLAIM, value => ({ [CODEX_AUTH_CLAIM]: { chatgpt_account_id: value } })],
];

const EMAIL_CLAIMS: Array<[string, (value: string) => Record<string, unknown>]> = [
	["email", value => ({ email: value })],
	[CODEX_PROFILE_CLAIM, value => ({ [CODEX_PROFILE_CLAIM]: { email: value } })],
];

function keyOf(provider: string, fields: Partial<OAuthCredential>): string | null {
	const credential: OAuthCredential = { type: "oauth", access: "opaque", refresh: "opaque", expires: 0, ...fields };
	return serializeCredential(provider, credential)?.identityKey ?? null;
}

describe("an identity a token carries keys the row as the same identity in a field does", () => {
	for (const [claim, place] of ACCOUNT_CLAIMS) {
		it(`reads the account from ${claim} in the access or refresh token`, () => {
			const expected = keyOf("github-copilot", { accountId: "acct-1" });
			expect(expected).toBe("account:acct-1");
			expect(keyOf("github-copilot", { access: jwt(place(" acct-1 ")) })).toBe(expected);
			expect(keyOf("github-copilot", { refresh: jwt(place("acct-1")) })).toBe(expected);
		});
	}

	for (const [claim, place] of EMAIL_CLAIMS) {
		it(`reads the email from ${claim} in the access or refresh token`, () => {
			const expected = keyOf("anthropic", { email: "one@example.com", orgId: "org-1" });
			expect(expected).toBe("email:one@example.com|org:org-1");
			expect(keyOf("anthropic", { access: jwt(place(" One@Example.com ")), orgId: "org-1" })).toBe(expected);
			expect(keyOf("anthropic", { refresh: jwt(place("one@example.com")), orgId: "org-1" })).toBe(expected);
		});
	}

	ACCOUNT_CLAIMS.forEach(([earlier, placeEarlier], index) => {
		for (const [later, placeLater] of ACCOUNT_CLAIMS.slice(index + 1)) {
			it(`reads ${earlier} before ${later}`, () => {
				const token = jwt({ ...placeLater("acct-later"), ...placeEarlier("acct-earlier") });
				expect(keyOf("github-copilot", { access: token })).toBe("account:acct-earlier");
			});
		}
	});

	it("reads the direct email claim before the profile claim", () => {
		const token = jwt({ [CODEX_PROFILE_CLAIM]: { email: "two@example.com" }, email: "one@example.com" });
		expect(keyOf("anthropic", { access: token })).toBe("email:one@example.com");
	});

	it("reads the credential's fields before its access token, and the access token before the refresh token", () => {
		const access = jwt({ email: "two@example.com", account_id: "acct-2" });
		const refresh = jwt({ email: "three@example.com", account_id: "acct-3" });
		expect(keyOf("anthropic", { email: "one@example.com", access, refresh })).toBe("email:one@example.com");
		expect(keyOf("github-copilot", { accountId: "acct-1", access, refresh })).toBe("account:acct-1");
		expect(keyOf("anthropic", { access, refresh })).toBe("email:two@example.com");
		expect(keyOf("github-copilot", { access, refresh })).toBe("account:acct-2");
		expect(keyOf("github-copilot", { access: "opaque", refresh })).toBe("account:acct-3");
	});

	it("keys nothing from a token that is not a JWT or carries no identity", () => {
		for (const token of ["opaque", "a.b", `h.${Buffer.from("[1]").toString("base64url")}.s`, jwt({ email: " " })]) {
			expect(keyOf("github-copilot", { access: token, refresh: token })).toBeNull();
			expect(extractOAuthTokenIdentifiers(token)).toBeUndefined();
		}
		expect(extractOAuthTokenIdentifiers(undefined)).toBeUndefined();
	});

	it("lists a token's identifiers as direct email, profile email, then account", () => {
		const token = jwt({
			sub: " acct-1 ",
			[CODEX_PROFILE_CLAIM]: { email: "Two@Example.com" },
			email: "one@example.com",
		});
		expect(extractOAuthTokenIdentifiers(token)).toEqual([
			"email:one@example.com",
			"email:two@example.com",
			"account:acct-1",
		]);
	});
});
