import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { DEFAULT_CALLBACK_PATH, OAuthCallbackFlow } from "@veyyon/ai/oauth/callback-server";
import type { OAuthController, OAuthCredentials } from "@veyyon/ai/oauth/types";

/**
 * The default loopback path an OAuth provider redirects back to, and the one place it is decided.
 *
 * `OAuthCallbackFlow` serves this path, so it decides it. Four callers each kept their own
 * `const CALLBACK_PATH = "/callback"` to hand the same value back to it: `anthropic.ts` passed it
 * positionally to `super`, `devin.ts` and `gitlab-duo.ts` passed it as an option, and the MCP flow in
 * `@veyyon/coding-agent` used it as its own last-resort fallback while importing the very class whose
 * default it was duplicating. Changing the served path would have moved the route this class listens on and
 * left all four still advertising the old one to the authorization server, so the failure would surface as
 * a redirect-URI mismatch on the provider's own error page rather than anywhere in this codebase.
 *
 * These pin the exact bytes, that the class's own default really is this value on both of its constructor
 * shapes, and that no other module redeclares it. Provider-specific paths are NOT part of this contract:
 * `openai-codex` serves `/auth/callback`, `google-antigravity` serves `/oauth-callback` and
 * `google-gemini-cli` serves `/oauth2callback`, each because that provider's registered redirect URI says
 * so, and those stay local to their own module.
 */

const AI_SRC = path.resolve(import.meta.dir, "../src");
const OWNER = "registry/oauth/callback-server.ts";

/**
 * The smallest concrete flow this class allows, so the constructor's own defaults can be read back. Neither
 * abstract method is reached: nothing here starts a server or contacts a provider.
 */
class ProbeFlow extends OAuthCallbackFlow {
	generateAuthUrl(): Promise<{ url: string; instructions?: string }> {
		throw new Error("this suite never starts a flow");
	}
	exchangeToken(): Promise<OAuthCredentials> {
		throw new Error("this suite never exchanges a token");
	}
}

const NO_CONTROLLER = {} as OAuthController;

describe("the default OAuth callback path", () => {
	/**
	 * The bytes a provider's registered redirect URI has to match. A leading slash and no trailing one:
	 * the flow compares this against the request pathname, so either mistake is a 404 on the redirect and
	 * an OAuth flow that hangs until it times out.
	 */
	it("is /callback", () => {
		expect(DEFAULT_CALLBACK_PATH).toBe("/callback");
	});

	/** Serving a bare origin or a relative path would never match a redirect pathname. */
	it("is an absolute path with no trailing slash and no query", () => {
		expect(DEFAULT_CALLBACK_PATH.startsWith("/")).toBeTrue();
		expect(DEFAULT_CALLBACK_PATH.endsWith("/")).toBeFalse();
		expect(DEFAULT_CALLBACK_PATH).not.toContain("?");
		expect(new URL(DEFAULT_CALLBACK_PATH, "http://localhost:1234").pathname).toBe("/callback");
	});
});

describe("OAuthCallbackFlow defaults to the exported path", () => {
	/**
	 * The options constructor is what `devin.ts` and `gitlab-duo.ts` use. Omitting `callbackPath` has to
	 * land on the exported value, because that is what makes passing it in redundant rather than necessary.
	 */
	it("uses it when the options form omits callbackPath", () => {
		const flow = new ProbeFlow(NO_CONTROLLER, { preferredPort: 61_234 });
		expect(flow.callbackPath).toBe(DEFAULT_CALLBACK_PATH);
	});

	/**
	 * The positional constructor is what `anthropic.ts` uses, and it has its own default expression. A
	 * second literal there would be invisible: the flow would serve one path while the exported constant
	 * said another.
	 */
	it("uses it when the positional form omits callbackPath", () => {
		const flow = new ProbeFlow(NO_CONTROLLER, 61_235);
		expect(flow.callbackPath).toBe(DEFAULT_CALLBACK_PATH);
	});

	/** An explicit provider path still wins, which is how the three non-default providers work. */
	it("still honours an explicit provider path", () => {
		const flow = new ProbeFlow(NO_CONTROLLER, { preferredPort: 61_236, callbackPath: "/oauth2callback" });
		expect(flow.callbackPath).toBe("/oauth2callback");
	});
});

describe("the default path has one owner", () => {
	async function oauthSources(): Promise<Array<{ file: string; text: string }>> {
		const files = [...new Bun.Glob("registry/oauth/**/*.ts").scanSync(AI_SRC)]
			.map(file => file.split(path.sep).join("/"))
			.sort();
		return await Promise.all(
			files.map(async file => ({ file, text: await Bun.file(path.join(AI_SRC, file)).text() })),
		);
	}

	/**
	 * The ratchet. Three of the four duplicates lived in this directory, each one line long and each
	 * looking harmless on its own. This fails the moment a fourth appears.
	 */
	it("declares the literal in callback-server.ts and nowhere else under registry/oauth", async () => {
		const declarers = (await oauthSources())
			.filter(entry => /=\s*"\/callback"/.test(entry.text))
			.map(entry => entry.file);
		expect(declarers).toEqual([OWNER]);
	});

	/**
	 * The non-vacuity twin. A broken glob would let the case above pass by reading nothing, so this proves
	 * the scan covers the providers that used to declare it and can see the literal in the owner.
	 */
	it("scans the providers that used to declare it", async () => {
		const files = (await oauthSources()).map(entry => entry.file);
		for (const provider of [
			"registry/oauth/anthropic.ts",
			"registry/oauth/devin.ts",
			"registry/oauth/gitlab-duo.ts",
		]) {
			expect(files).toContain(provider);
		}
		const owner = await Bun.file(path.join(AI_SRC, OWNER)).text();
		expect(owner).toContain('export const DEFAULT_CALLBACK_PATH = "/callback";');
	});

	/**
	 * The positive half: each former declarer now imports the value. A module that had gone back to its own
	 * literal spelled differently would slip past the ratchet above but not past this.
	 */
	it("has every former declarer importing the owner's constant", async () => {
		for (const provider of [
			"registry/oauth/anthropic.ts",
			"registry/oauth/devin.ts",
			"registry/oauth/gitlab-duo.ts",
		]) {
			const text = await Bun.file(path.join(AI_SRC, provider)).text();
			expect(text).toContain("DEFAULT_CALLBACK_PATH");
			expect(text).toMatch(/from "\.\/callback-server";/);
		}
	});

	/**
	 * The MCP flow in `@veyyon/coding-agent` was the fourth copy, and the odd one: it imported
	 * `OAuthCallbackFlow` from this module and then redeclared that class's own default as its fallback.
	 * It is asserted from here because this module is what the value belongs to, wherever a duplicate lived.
	 */
	it("has the MCP flow taking the fallback from here rather than redeclaring it", async () => {
		const mcpFlow = path.resolve(import.meta.dir, "../../coding-agent/src/mcp/oauth-flow.ts");
		const text = await Bun.file(mcpFlow).text();
		expect(text).toContain(
			'import { DEFAULT_CALLBACK_PATH, OAuthCallbackFlow } from "@veyyon/ai/oauth/callback-server";',
		);
		expect(text).not.toMatch(/=\s*"\/callback"/);
	});

	/**
	 * The three provider-specific paths are deliberately NOT unified: each is what that provider has
	 * registered as its redirect URI, so they are provider facts and not a shared default. Recorded as an
	 * expectation so that collapsing them into the owner fails here and has to be argued for.
	 */
	it("leaves each provider-specific path local to its provider", async () => {
		const expected = new Map([
			["registry/oauth/openai-codex.ts", "/auth/callback"],
			["registry/oauth/google-antigravity.ts", "/oauth-callback"],
			["registry/oauth/google-gemini-cli.ts", "/oauth2callback"],
		]);
		for (const [file, servedPath] of expected) {
			const text = await Bun.file(path.join(AI_SRC, file)).text();
			expect(text).toContain(`const CALLBACK_PATH = "${servedPath}";`);
			expect(servedPath).not.toBe(DEFAULT_CALLBACK_PATH);
		}
	});
});
