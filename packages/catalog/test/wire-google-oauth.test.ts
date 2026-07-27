/**
 * ONE-PLACE lock for Google's OAuth endpoints and the scopes veyyon asks for.
 *
 * Why this suite exists: three modules in `@veyyon/ai` talk to Google's OAuth service and each declared its
 * own copies. `registry/oauth/google-gemini-cli.ts` and `registry/oauth/google-antigravity.ts` both had
 * `AUTH_URL`, `TOKEN_URL` and a `SCOPES` array whose first three entries were identical;
 * `providers/google-auth.ts` had the same token endpoint as `OAUTH_TOKEN_URL` and the same cloud-platform
 * scope as `CLOUD_PLATFORM_SCOPE`. Three declarations of the token endpoint under two names, two of the
 * authorize endpoint, and three of the cloud-platform scope.
 *
 * WHY A WRONG SCOPE IS WORSE THAN A WRONG ENDPOINT, and the reason this is a correctness lock rather than
 * tidiness: a mistyped endpoint fails immediately with DNS or a 404. A mistyped scope SUCCEEDS. Google issues
 * a token, the token simply lacks the permission, and the failure arrives later as a 403 from whatever the
 * token was for, naming the API rather than the scope that was never granted. Nothing in the sign-in reports
 * it, so the user sees a successful login followed by an unrelated-looking error.
 *
 * The scope ORDER is part of the contract too. The scope string identifies a grant, so reordering it can
 * present a fresh consent screen for permissions the user already gave.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	GOOGLE_BASE_OAUTH_SCOPES,
	GOOGLE_OAUTH_AUTH_ENDPOINT,
	GOOGLE_OAUTH_TOKEN_ENDPOINT,
	GOOGLE_SCOPE_CLOUD_PLATFORM,
	GOOGLE_SCOPE_USERINFO_EMAIL,
	GOOGLE_SCOPE_USERINFO_PROFILE,
} from "../src/wire/google-oauth";

const AI_SRC = path.resolve(import.meta.dir, "../../ai/src");
const OWNER_REL = "../src/wire/google-oauth.ts";

/** The modules that each held a copy and must now read the owner. */
const FORMER_DECLARERS = [
	"registry/oauth/google-gemini-cli.ts",
	"registry/oauth/google-antigravity.ts",
	"providers/google-auth.ts",
] as const;

describe("Google's OAuth endpoints", () => {
	/** The authorize endpoint, v2, pinned as bytes: the v1 path still resolves and behaves differently. */
	it("holds the v2 authorization endpoint", () => {
		expect(GOOGLE_OAUTH_AUTH_ENDPOINT).toBe("https://accounts.google.com/o/oauth2/v2/auth");
	});

	/**
	 * The token endpoint, which serves BOTH the code exchange and every refresh. One constant for both is the
	 * point: a flow exchanging its code on one host and refreshing on another signs in fine and then fails hours
	 * later, when nobody connects the failure to the sign-in.
	 */
	it("holds the token endpoint", () => {
		expect(GOOGLE_OAUTH_TOKEN_ENDPOINT).toBe("https://oauth2.googleapis.com/token");
	});

	/** Different hosts for the two, which is easy to get wrong from memory. */
	it("keeps the authorize and token endpoints on different hosts", () => {
		expect(new URL(GOOGLE_OAUTH_AUTH_ENDPOINT).host).toBe("accounts.google.com");
		expect(new URL(GOOGLE_OAUTH_TOKEN_ENDPOINT).host).toBe("oauth2.googleapis.com");
	});

	/** Both https, since a token would otherwise cross the wire in the clear. */
	it("serves both endpoints over https", () => {
		for (const endpoint of [GOOGLE_OAUTH_AUTH_ENDPOINT, GOOGLE_OAUTH_TOKEN_ENDPOINT]) {
			expect(new URL(endpoint).protocol, endpoint).toBe("https:");
		}
	});
});

describe("the scopes veyyon requests", () => {
	/** Each scope, as bytes. A scope is a lookup key on Google's side, not a description. */
	it("holds each scope URI exactly", () => {
		expect(GOOGLE_SCOPE_CLOUD_PLATFORM).toBe("https://www.googleapis.com/auth/cloud-platform");
		expect(GOOGLE_SCOPE_USERINFO_EMAIL).toBe("https://www.googleapis.com/auth/userinfo.email");
		expect(GOOGLE_SCOPE_USERINFO_PROFILE).toBe("https://www.googleapis.com/auth/userinfo.profile");
	});

	/**
	 * The trio, IN ORDER. The order is asserted rather than the set, because the scope string identifies a grant
	 * and reordering it can re-prompt the user for consent they already gave.
	 */
	it("requests exactly three scopes in a fixed order", () => {
		expect([...GOOGLE_BASE_OAUTH_SCOPES]).toEqual([
			"https://www.googleapis.com/auth/cloud-platform",
			"https://www.googleapis.com/auth/userinfo.email",
			"https://www.googleapis.com/auth/userinfo.profile",
		]);
	});

	/** No duplicates, since a repeated scope is sent verbatim in the request and changes the grant string. */
	it("lists each scope once", () => {
		expect(new Set(GOOGLE_BASE_OAUTH_SCOPES).size).toBe(GOOGLE_BASE_OAUTH_SCOPES.length);
	});

	/** Every scope is a Google API scope URI, which is the shape Google rejects outright if it is wrong. */
	it("holds only googleapis.com auth scopes", () => {
		for (const scope of GOOGLE_BASE_OAUTH_SCOPES) {
			const url = new URL(scope);
			expect(url.host, scope).toBe("www.googleapis.com");
			expect(url.pathname.startsWith("/auth/"), scope).toBeTrue();
		}
	});
});

describe("both sign-in flows read one declaration", () => {
	/**
	 * Gemini CLI requests exactly the shared trio, so it takes the list rather than restating it. Read from the
	 * shipped module so this proves the wiring and not just the constant.
	 */
	it("has the Gemini CLI flow requesting the shared trio", async () => {
		const flow = await Bun.file(path.join(AI_SRC, "registry/oauth/google-gemini-cli.ts")).text();
		expect(flow).toContain("const SCOPES = GOOGLE_BASE_OAUTH_SCOPES;");
		expect(flow).toContain("const AUTH_URL = GOOGLE_OAUTH_AUTH_ENDPOINT;");
		expect(flow).toContain("const TOKEN_URL = GOOGLE_OAUTH_TOKEN_ENDPOINT;");
	});

	/**
	 * Antigravity needs two more, `cclog` and `experimentsandconfigs`, which stay with it because no other flow
	 * asks for them. Appended after the shared trio rather than interleaved, since the order is part of the grant.
	 */
	it("has Antigravity appending only its own two scopes", async () => {
		const flow = await Bun.file(path.join(AI_SRC, "registry/oauth/google-antigravity.ts")).text();
		expect(flow).toContain("...GOOGLE_BASE_OAUTH_SCOPES,");
		expect(flow).toContain('"https://www.googleapis.com/auth/cclog"');
		expect(flow).toContain('"https://www.googleapis.com/auth/experimentsandconfigs"');
		// The shared three are no longer written out here.
		expect(flow).not.toContain('"https://www.googleapis.com/auth/cloud-platform"');
		expect(flow).not.toContain('"https://www.googleapis.com/auth/userinfo.email"');
	});

	/**
	 * The shared login runner accepts a frozen scope list. Its option was `string[]`, which rejected a shared
	 * readonly array, and widening it is correct on its own terms: it only joins the scopes into a request
	 * parameter and has no reason to mutate the caller's list.
	 */
	it("accepts a readonly scope list in the shared runner", async () => {
		const runner = await Bun.file(path.join(AI_SRC, "registry/oauth/google-oauth-shared.ts")).text();
		expect(runner).toContain("scopes: readonly string[];");
		expect(runner).toContain('this.config.scopes.join(" ")');
	});

	/** The service-account path reads the same token endpoint and the same cloud-platform scope. */
	it("has the service-account path reading the owner", async () => {
		const auth = await Bun.file(path.join(AI_SRC, "providers/google-auth.ts")).text();
		expect(auth).toContain("GOOGLE_OAUTH_TOKEN_ENDPOINT");
		expect(auth).toContain("GOOGLE_SCOPE_CLOUD_PLATFORM");
		expect(auth).not.toContain("const OAUTH_TOKEN_URL");
		expect(auth).not.toContain("const CLOUD_PLATFORM_SCOPE");
	});
});

describe("the Google OAuth values have one owner", () => {
	async function aiSources(): Promise<ReadonlyArray<{ file: string; text: string }>> {
		const files = [...new Bun.Glob("**/*.ts").scanSync(AI_SRC)]
			.map(file => file.split(path.sep).join("/"))
			// The provider's own tests build a fixture token against these URLs, which is a test double rather
			// than a second declaration of where a request goes.
			.filter(file => !file.includes("__tests__"))
			.sort();
		return await Promise.all(
			files.map(async file => ({ file, text: await Bun.file(path.join(AI_SRC, file)).text() })),
		);
	}

	/**
	 * The ratchet, keyed on the LITERALS, because the copies used four different names between them and a fifth
	 * copy would pick a fifth name. Antigravity's own two scopes are excluded by construction: only the shared
	 * values are listed.
	 */
	it("spells no shared endpoint or scope outside the owner", async () => {
		const shared = [
			GOOGLE_OAUTH_AUTH_ENDPOINT,
			GOOGLE_OAUTH_TOKEN_ENDPOINT,
			GOOGLE_SCOPE_CLOUD_PLATFORM,
			GOOGLE_SCOPE_USERINFO_EMAIL,
			GOOGLE_SCOPE_USERINFO_PROFILE,
		];
		const offenders: string[] = [];
		for (const { file, text } of await aiSources()) {
			for (const value of shared) {
				if (text.includes(`"${value}"`)) offenders.push(`${file} spells ${value}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/** Nor declares one of the names the copies used. */
	it("declares none of the retired names", async () => {
		const offenders: string[] = [];
		for (const { file, text } of await aiSources()) {
			for (const name of ["OAUTH_TOKEN_URL", "CLOUD_PLATFORM_SCOPE"]) {
				if (new RegExp(`^\\s*(?:export )?const ${name}\\b`, "m").test(text)) offenders.push(`${file}: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * The non-vacuity twin. Both ratchets pass over an empty scan, so require that it reaches the package and
	 * every module that held a copy.
	 */
	it("scans the ai package including all three former declarers", async () => {
		const files = (await aiSources()).map(entry => entry.file);
		expect(files.length).toBeGreaterThan(150);
		for (const declarer of FORMER_DECLARERS) expect(files).toContain(declarer);
	});

	/**
	 * The owner is a leaf. Reaching a scope through a provider module would mean importing that provider's whole
	 * flow, which is the cost that made these strings worth retyping in the first place.
	 */
	it("imports nothing", async () => {
		const owner = await Bun.file(path.resolve(import.meta.dir, OWNER_REL)).text();
		expect(owner).not.toMatch(/^\s*import\s/m);
		expect(owner).not.toMatch(/\bfrom\s+"/);
	});
});
