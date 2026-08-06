import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	ANTIGRAVITY_PRIMARY_ENDPOINT as ANTIGRAVITY_PRIMARY_VIA_DISCOVERY,
	ANTIGRAVITY_SANDBOX_ENDPOINT as ANTIGRAVITY_SANDBOX_VIA_DISCOVERY,
} from "@veyyon/catalog/discovery/antigravity";
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
} from "@veyyon/catalog/provider-endpoints";
import { moduleSpecifiersIn, namedImportsFrom, withoutComments } from "@veyyon/utils/module-reach";

/**
 * The endpoint names a module takes from the owner, by either spelling of the specifier.
 *
 * Sources inside `@veyyon/catalog` reach it relatively; everything else reaches it by package
 * subpath, and a consumer is free to move between the two without changing what it depends on.
 */
function importedEndpoints(source: string): string[] {
	return [
		...namedImportsFrom(source, "@veyyon/catalog/provider-endpoints"),
		...namedImportsFrom(source, "../provider-endpoints"),
		...namedImportsFrom(source, "../../provider-endpoints"),
		...namedImportsFrom(source, "./provider-endpoints"),
	];
}

/**
 * Google's Cloud Code Assist and Antigravity base URLs, and the one place they are written.
 *
 * These are three strings that a request either reaches or does not, so a wrong one is a total outage for
 * the provider it belongs to, not a degradation. They were written in ten modules under nine names:
 * `https://cloudcode-pa.googleapis.com` six times as `DEFAULT_ENDPOINT`, `CLOUD_CODE_ENDPOINT`,
 * `CODE_ASSIST_ENDPOINT` and `CLOUD_CODE_ASSIST_ENDPOINT`, and the Antigravity daily host six more times
 * including once as a bare literal inside a settings switch. `catalog/discovery/antigravity.ts` did export
 * two of them, but reaching that export drags in arktype and the entire discovery machinery for one
 * string, which is why the value kept being retyped rather than imported.
 *
 * The suites below pin the exact bytes rather than the shape, because every failure mode here is a wrong
 * host that still looks like a URL. The ordered fallback list is pinned too: Antigravity is tried on the
 * daily host and then the sandbox host, and four modules each kept a copy of that pair, one of them with
 * the sandbox host as an inline literal beside its named constant, so a host rotation would have updated
 * the name and missed the literal. The last suite is the ratchet that stops an eleventh copy appearing.
 */

describe("the Google Cloud Code and Antigravity hosts", () => {
	/**
	 * Cloud Code Assist serves Gemini CLI credential loading, `v1internal` model and onboarding calls, and
	 * Gemini usage reporting. Six modules spelled this out; a typo in any one of them would have broken
	 * exactly one of those paths and left the others working, which is the hardest kind of report to read.
	 */
	it("serves Cloud Code Assist from cloudcode-pa.googleapis.com over https with no trailing slash", () => {
		expect(CLOUD_CODE_ENDPOINT).toBe("https://cloudcode-pa.googleapis.com");
	});

	/** Antigravity's production host, the one a request goes to when nothing is configured. */
	it("serves Antigravity from daily-cloudcode-pa.googleapis.com", () => {
		expect(ANTIGRAVITY_PRIMARY_ENDPOINT).toBe("https://daily-cloudcode-pa.googleapis.com");
	});

	/** The sandbox host, selected explicitly by `providers.antigravityEndpoint` and tried as a fallback. */
	it("serves the Antigravity sandbox from daily-cloudcode-pa.sandbox.googleapis.com", () => {
		expect(ANTIGRAVITY_SANDBOX_ENDPOINT).toBe("https://daily-cloudcode-pa.sandbox.googleapis.com");
	});

	/**
	 * The sandbox host is the production host with `.sandbox` inserted, which is precisely why a copy of one
	 * can be edited into the other by accident. If these ever collapsed to the same string, the fallback
	 * chain would retry the host that just failed and the sandbox setting would silently do nothing.
	 */
	it("keeps the production and sandbox hosts distinct", () => {
		expect(ANTIGRAVITY_SANDBOX_ENDPOINT).not.toBe(ANTIGRAVITY_PRIMARY_ENDPOINT);
	});

	/**
	 * Every host is a bare origin. A trailing slash would double up when a caller appends `/v1internal:...`,
	 * and a path segment here would be silently prefixed onto every request.
	 */
	it("stores bare origins, so appending a path cannot produce a double slash", () => {
		for (const endpoint of [CLOUD_CODE_ENDPOINT, ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT]) {
			expect(new URL(endpoint).pathname).toBe("/");
			expect(endpoint.endsWith("/")).toBeFalse();
			expect(new URL(endpoint).protocol).toBe("https:");
		}
	});
});

describe("the Antigravity fallback order", () => {
	/**
	 * The order is the contract: production first, sandbox second. Four modules each had their own copy of
	 * this pair, so a reordering in one would have made two providers disagree about which host is tried
	 * first, and the only visible symptom would be different latency.
	 */
	it("tries the production host before the sandbox host", () => {
		expect([...ANTIGRAVITY_ENDPOINTS]).toEqual([
			"https://daily-cloudcode-pa.googleapis.com",
			"https://daily-cloudcode-pa.sandbox.googleapis.com",
		]);
	});

	/** The list is built from the same constants the callers import, not from a second copy of the strings. */
	it("is built from the exported hosts", () => {
		expect(ANTIGRAVITY_ENDPOINTS[0]).toBe(ANTIGRAVITY_PRIMARY_ENDPOINT);
		expect(ANTIGRAVITY_ENDPOINTS[1]).toBe(ANTIGRAVITY_SANDBOX_ENDPOINT);
		expect(ANTIGRAVITY_ENDPOINTS).toHaveLength(2);
	});

	/**
	 * Callers spread this list into a mutable array because several of them narrow it to one host. If a
	 * caller narrowed the shared list in place instead, every later caller in the process would inherit the
	 * narrowing and lose its fallback. The `as const` makes that a type error; this records why.
	 */
	it("is frozen at the type level so a caller narrowing its own copy cannot narrow everyone's", () => {
		const narrowed: string[] = [...ANTIGRAVITY_ENDPOINTS];
		narrowed.length = 1;
		expect(narrowed).toEqual(["https://daily-cloudcode-pa.googleapis.com"]);
		expect(ANTIGRAVITY_ENDPOINTS).toHaveLength(2);
	});
});

describe("catalog/discovery/antigravity re-exports rather than redeclaring", () => {
	/**
	 * `discovery/antigravity.ts` exported these two names before the owner existed, and a test and the
	 * model-generation script import them from there. Turning those exports into re-exports keeps both
	 * callers working while leaving one definition. `toBe` is the assertion that matters: an equal-looking
	 * second literal would pass a `toEqual` and would be the duplicate this suite exists to prevent.
	 */
	it("hands back the owner's own values", () => {
		expect(ANTIGRAVITY_PRIMARY_VIA_DISCOVERY).toBe(ANTIGRAVITY_PRIMARY_ENDPOINT);
		expect(ANTIGRAVITY_SANDBOX_VIA_DISCOVERY).toBe(ANTIGRAVITY_SANDBOX_ENDPOINT);
	});

	/**
	 * And the module really does re-export rather than assign, so there is nothing left to drift.
	 *
	 * Keyed on the DECLARATION form rather than on a formatted `export { ... } from "...";` line.
	 * Both endpoints are strings, so a second identical literal is `===` the owner's and the
	 * identity case above cannot see it; this is the half that can. Anchoring on the whole
	 * re-export line instead would report the formatter's line wrapping rather than the code.
	 */
	it("declares neither endpoint, so both can only come from the owner", async () => {
		const source = await Bun.file(path.resolve(import.meta.dir, "../src/discovery/antigravity.ts")).text();
		const code = withoutComments(source);

		for (const name of ["ANTIGRAVITY_PRIMARY_ENDPOINT", "ANTIGRAVITY_SANDBOX_ENDPOINT"]) {
			expect(new RegExp(`(?:const|let|var)\\s+${name}\\b`).test(code), `${name} is declared here`).toBe(false);
		}
		expect(code).toMatch(/export\s*\{[^}]*ANTIGRAVITY_PRIMARY_ENDPOINT[^}]*\}\s*from\s*"\.\.\/provider-endpoints"/);
		expect(code).toMatch(/export\s*\{[^}]*ANTIGRAVITY_SANDBOX_ENDPOINT[^}]*\}\s*from\s*"\.\.\/provider-endpoints"/);
	});
});

describe("GitLab's SaaS instance", () => {
	/**
	 * The default when no self-managed instance URL is configured. GitLab is the provider most likely to be
	 * self-hosted, so this is the fallback every unconfigured GitLab request depends on: the OAuth authorize
	 * and token endpoints and the Duo API all live on whichever instance the user actually has.
	 */
	it("is https://gitlab.com", () => {
		expect(GITLAB_SAAS_URL).toBe("https://gitlab.com");
	});

	/**
	 * A bare origin, because every caller appends a path (`/oauth/authorize`, `/oauth/token`,
	 * `/api/v4/ai/...`). A trailing slash would produce a double slash in each of them.
	 */
	it("is a bare https origin with no trailing slash", () => {
		expect(new URL(GITLAB_SAAS_URL).pathname).toBe("/");
		expect(GITLAB_SAAS_URL.endsWith("/")).toBeFalse();
		expect(new URL(GITLAB_SAAS_URL).protocol).toBe("https:");
	});

	/**
	 * Five modules across two packages each declared this under one of three names (`GITLAB_COM_URL` three
	 * times, `GITLAB_DEFAULT_BASE_URL`, `DEFAULT_GITLAB_BASE_URL`). Three names for one value is worse than
	 * three copies of one name: a grep for either of the others finds nothing, so a reader has no way to know
	 * the value is shared at all.
	 */
	it("is the value all five former declarers now use", async () => {
		const packagesDir = path.resolve(import.meta.dir, "../..");
		for (const file of [
			"catalog/src/discovery/gitlab-duo-workflow.ts",
			"ai/src/providers/gitlab-duo.ts",
			"ai/src/providers/gitlab-duo-workflow.ts",
			"ai/src/registry/oauth/gitlab-duo.ts",
			"ai/src/registry/oauth/gitlab-duo-workflow.ts",
		]) {
			const text = await Bun.file(path.join(packagesDir, file)).text();
			expect(text).toContain("GITLAB_SAAS_URL");
			expect(text).not.toContain("GITLAB_COM_URL");
			expect(text).not.toContain("GITLAB_DEFAULT_BASE_URL");
			expect(text).not.toContain("DEFAULT_GITLAB_BASE_URL");
		}
	});
});

describe("Devin's three hosts", () => {
	/**
	 * The chat host, which is still a `codeium.com` domain because Devin is Cognition's rebrand of Codeium's
	 * Cascade backend. That surprise is exactly why it needs a name: `server.codeium.com` sitting in a Devin code
	 * path reads like a mistake until you know.
	 */
	it("serves Cascade chat from server.codeium.com", () => {
		expect(DEVIN_CASCADE_ENDPOINT).toBe("https://server.codeium.com");
	});

	/** The token host, which serves the CLI OAuth exchange and is not the chat host. */
	it("serves tokens from api.devin.ai", () => {
		expect(DEVIN_AUTH_ENDPOINT).toBe("https://api.devin.ai");
	});

	/** The web app a user is sent to in order to approve a CLI login. Not an API at all. */
	it("hosts login approval on app.devin.ai", () => {
		expect(DEVIN_WEBAPP_URL).toBe("https://app.devin.ai");
	});

	/**
	 * THREE DISTINCT HOSTS, which is the reason each has its own name. Two of them used to be declared as
	 * `DEVIN_API_URL`: the chat host in `ai/src/providers/devin.ts`, which EXPORTED it, and the token host in the
	 * sibling `ai/src/registry/oauth/devin.ts`. Anything reaching for "the Devin API URL" in order to
	 * authenticate would have imported the chat host and failed against an endpoint that does not serve tokens.
	 */
	it("keeps all three hosts distinct", () => {
		const hosts = [DEVIN_CASCADE_ENDPOINT, DEVIN_AUTH_ENDPOINT, DEVIN_WEBAPP_URL];
		expect(new Set(hosts).size).toBe(3);
		expect(new Set(hosts.map(host => new URL(host).hostname)).size).toBe(3);
	});

	/** Each is a bare https origin, since every caller appends a path such as `/auth/cli/token`. */
	it("holds bare https origins", () => {
		for (const host of [DEVIN_CASCADE_ENDPOINT, DEVIN_AUTH_ENDPOINT, DEVIN_WEBAPP_URL]) {
			expect(new URL(host).pathname, host).toBe("/");
			expect(host.endsWith("/"), host).toBeFalse();
			expect(new URL(host).protocol, host).toBe("https:");
		}
	});

	/**
	 * The ratchet on the retired name, across all three former declarers. The chat host had a THIRD declaration
	 * in `catalog/src/discovery/devin.ts` under yet another name, `DEVIN_DEFAULT_BASE_URL`, so that spelling is
	 * checked too.
	 */
	it("has every former declarer using the named hosts", async () => {
		const packagesDir = path.resolve(import.meta.dir, "../..");
		const expectations: Array<[string, string]> = [
			["catalog/src/discovery/devin.ts", "DEVIN_CASCADE_ENDPOINT"],
			["ai/src/providers/devin.ts", "DEVIN_CASCADE_ENDPOINT"],
			["ai/src/registry/oauth/devin.ts", "DEVIN_AUTH_ENDPOINT"],
		];
		for (const [file, expected] of expectations) {
			const text = await Bun.file(path.join(packagesDir, file)).text();
			// One assertion for both halves. TypeScript refuses a module that both imports a binding
			// and declares it, so "imports DEVIN_CASCADE_ENDPOINT from the owner" IS "keeps no private
			// copy under any name" -- including the two retired spellings this used to chase by regex,
			// and the third one nobody thought to add.
			expect(importedEndpoints(text), file).toContain(expected);
		}
	});
});

describe("Gemini, Anthropic and Cursor", () => {
	/**
	 * The Gemini developer API base, path included. `/v1beta` is part of the value rather than something a
	 * caller appends, because every consumer needs the same version: the host is stable and the version is not,
	 * and the three declarations this replaces shared no name, so a bump had to find all three by luck.
	 */
	it("holds the Gemini developer API base with its version segment", () => {
		expect(GEMINI_DEVELOPER_API_ENDPOINT).toBe("https://generativelanguage.googleapis.com/v1beta");
		expect(GEMINI_DEVELOPER_API_ENDPOINT.endsWith("/v1beta")).toBeTrue();
	});

	/**
	 * It is a different host from Cloud Code Assist, which is the distinction the three names obscured: an API
	 * key talks to the developer API, and an OAuth credential talks to Cloud Code Assist.
	 */
	it("keeps the developer API separate from Cloud Code Assist", () => {
		expect(new URL(GEMINI_DEVELOPER_API_ENDPOINT).host).not.toBe(new URL(CLOUD_CODE_ENDPOINT).host);
	});

	/** Anthropic's official host, with no path and no trailing slash, since callers append their own. */
	it("holds Anthropic's official host bare", () => {
		expect(ANTHROPIC_API_ENDPOINT).toBe("https://api.anthropic.com");
		expect(new URL(ANTHROPIC_API_ENDPOINT).pathname).toBe("/");
		expect(ANTHROPIC_API_ENDPOINT.endsWith("/")).toBeFalse();
	});

	/**
	 * THE REASON THIS ONE MATTERS. `compat/anthropic.ts` decides whether a configured base URL is Anthropic
	 * itself, and its check is exact-or-followed-by-a-slash rather than a prefix test, so a lookalike host
	 * cannot pass. Driven through the real predicate, including the lookalike its own doc names, because that
	 * check and the fallback TO this host used to read two different declarations of it.
	 */
	it("recognises the official host without accepting a lookalike", async () => {
		const { isOfficialAnthropicApiUrl } = await import("../src/compat/anthropic");
		expect(isOfficialAnthropicApiUrl(ANTHROPIC_API_ENDPOINT)).toBeTrue();
		expect(isOfficialAnthropicApiUrl(`${ANTHROPIC_API_ENDPOINT}/v1`)).toBeTrue();
		expect(isOfficialAnthropicApiUrl("https://api.anthropic.com.evil.com")).toBeFalse();
		expect(isOfficialAnthropicApiUrl("https://api.anthropic.com.evil.com/v1")).toBeFalse();
		expect(isOfficialAnthropicApiUrl("https://proxy.internal/anthropic")).toBeFalse();
	});

	/** Cursor's host, the fallback when nothing is configured. */
	it("holds Cursor's API host", () => {
		expect(CURSOR_API_ENDPOINT).toBe("https://api2.cursor.sh");
		expect(new URL(CURSOR_API_ENDPOINT).pathname).toBe("/");
	});

	/**
	 * `@veyyon/ai` publishes this host as `CURSOR_API_URL`, so the two names must be the same string. It is a
	 * re-export of the owner rather than a second declaration, and this is what pins that.
	 */
	it("keeps the ai package's published Cursor name pointing here", async () => {
		const { CURSOR_API_URL } = await import("@veyyon/ai/providers/cursor");
		expect(CURSOR_API_URL).toBe(CURSOR_API_ENDPOINT);
	});

	/** All three are https, since a plaintext fallback would send a credential in the clear. */
	it("serves every host over https", () => {
		for (const endpoint of [GEMINI_DEVELOPER_API_ENDPOINT, ANTHROPIC_API_ENDPOINT, CURSOR_API_ENDPOINT]) {
			expect(new URL(endpoint).protocol, endpoint).toBe("https:");
		}
	});

	/** The positive half: each former declarer takes its host from the owner. */
	it("has every former declarer importing its host", async () => {
		const expected: ReadonlyArray<[string, string]> = [
			["ai/src/providers/google.ts", "GEMINI_DEVELOPER_API_ENDPOINT"],
			["catalog/src/discovery/gemini.ts", "GEMINI_DEVELOPER_API_ENDPOINT"],
			["coding-agent/src/web/search/providers/gemini.ts", "GEMINI_DEVELOPER_API_ENDPOINT"],
			["ai/src/utils/anthropic-auth.ts", "ANTHROPIC_API_ENDPOINT"],
			["ai/src/providers/anthropic.ts", "ANTHROPIC_API_ENDPOINT"],
			["ai/src/providers/anthropic-client.ts", "ANTHROPIC_API_ENDPOINT"],
			["catalog/src/compat/anthropic.ts", "ANTHROPIC_API_ENDPOINT"],
			["catalog/src/discovery/cursor.ts", "CURSOR_API_ENDPOINT"],
			["ai/src/usage/cursor.ts", "CURSOR_API_ENDPOINT"],
			["ai/src/providers/cursor.ts", "CURSOR_API_ENDPOINT"],
		];
		const packagesDir = path.resolve(import.meta.dir, "../..");
		for (const [file, symbol] of expected) {
			const text = await Bun.file(path.join(packagesDir, file)).text();
			expect(importedEndpoints(text), file).toContain(symbol);
		}
	});
});

describe("OpenRouter's API base", () => {
	/** The base, `/v1` included, since every consumer appends a path to it. */
	it("holds the API base with its version segment", () => {
		expect(OPENROUTER_API_ENDPOINT).toBe("https://openrouter.ai/api/v1");
		expect(OPENROUTER_API_ENDPOINT.endsWith("/v1")).toBeTrue();
	});

	/**
	 * The name of the environment variable that OVERRIDES this value is `OPENROUTER_BASE_URL`, and two of the
	 * four modules that used to spell the URL called their constant the same thing. That is why the default now
	 * comes from one place: a reader could not tell the configured value from the fallback by name.
	 */
	it("is what @veyyon/mnemopi and the search provider fall back to", async () => {
		const packagesDir = path.resolve(import.meta.dir, "../..");
		for (const file of [
			"mnemopi/src/config.ts",
			"mnemopi/src/core/embeddings.ts",
			"mnemopi/src/core/extraction/client.ts",
			"coding-agent/src/web/search/providers/perplexity-auth.ts",
		]) {
			const text = await Bun.file(path.join(packagesDir, file)).text();
			expect(importedEndpoints(text), file).toContain("OPENROUTER_API_ENDPOINT");
		}
	});

	/** Both published names still resolve to the one value, since callers already import them. */
	it("keeps both published aliases pointing here", async () => {
		const { DEFAULT_EMBEDDING_API_URL } = await import("@veyyon/mnemopi/config");
		const { OPENROUTER_BASE_URL } = await import("@veyyon/coding-agent/web/search/providers/perplexity-auth");
		expect(DEFAULT_EMBEDDING_API_URL).toBe(OPENROUTER_API_ENDPOINT);
		expect(OPENROUTER_BASE_URL).toBe(OPENROUTER_API_ENDPOINT);
	});
});

describe("the hosts have one owner", () => {
	const PACKAGES_DIR = path.resolve(import.meta.dir, "../..");
	const OWNER = "catalog/src/provider-endpoints.ts";
	const HOSTS = [
		"cloudcode-pa.googleapis.com",
		"daily-cloudcode-pa.googleapis.com",
		"gitlab.com",
		"server.codeium.com",
		"api.devin.ai",
		"app.devin.ai",
		"api.anthropic.com",
		"api2.cursor.sh",
	];

	/**
	 * Endpoints whose PATH is part of the value, so the bare-host form above would not see a copy of them.
	 * The Gemini developer API is the case: `/v1beta` is the version every consumer has to agree on, and the
	 * three declarations it used to have shared no name, so a version bump had three places to find.
	 */
	const PATH_ENDPOINTS = ["https://generativelanguage.googleapis.com/v1beta", "https://openrouter.ai/api/v1"];
	/**
	 * The generated model database legitimately carries a `baseUrl` per model row, and the model catalog is
	 * data rather than a place a host is decided, so it is not a second declaration.
	 *
	 * `provider-models/openai-compat.ts` is the same kind of thing in TypeScript: one descriptor row per
	 * provider, each carrying the host its models are served from, alongside dozens of providers that have no
	 * constant here at all. Counting those rows would make this case report the catalog's data as duplication
	 * and there would be no honest way to satisfy it.
	 */
	const DATA_FILES = new Set(["catalog/src/models.json", "catalog/src/provider-models/openai-compat.ts"]);

	async function sourcesNamingAHost(): Promise<Array<{ file: string; text: string }>> {
		const files = [
			...new Bun.Glob("{catalog,ai,coding-agent,agent,utils,tui,mnemopi}/src/**/*.ts").scanSync(PACKAGES_DIR),
		]
			.map(file => file.split(path.sep).join("/"))
			.filter(file => !DATA_FILES.has(file))
			.sort();
		const read = await Promise.all(
			files.map(async file => ({ file, text: await Bun.file(path.join(PACKAGES_DIR, file)).text() })),
		);
		return read.filter(
			entry =>
				HOSTS.some(host => entry.text.includes(`"https://${host}"`)) ||
				PATH_ENDPOINTS.some(endpoint => entry.text.includes(`"${endpoint}"`)),
		);
	}

	/**
	 * The ratchet. Ten modules held a literal before the owner existed, and the reason they did was that the
	 * only export of one lived behind arktype. Now that taking a host costs one module there is no excuse
	 * for an eleventh copy, and this fails the moment one appears in any shipped source file.
	 */
	it("writes a host literal in provider-endpoints.ts and in no other shipped module", async () => {
		expect((await sourcesNamingAHost()).map(entry => entry.file)).toEqual([OWNER]);
	});

	/**
	 * The non-vacuity twin. If the glob stopped matching, the case above would pass by reading nothing at
	 * all, so this proves the scan really covers a package outside catalog and really can see a literal.
	 */
	it("scans far enough to see a module in another package", async () => {
		const scanned = [...new Bun.Glob("{catalog,ai,coding-agent,mnemopi}/src/**/*.ts").scanSync(PACKAGES_DIR)].map(
			file => file.split(path.sep).join("/"),
		);
		expect(scanned).toContain("ai/src/providers/google-gemini-cli.ts");
		expect(scanned).toContain("mnemopi/src/config.ts");
		expect(scanned).toContain("coding-agent/src/tools/image-gen.ts");
		expect(scanned.length).toBeGreaterThan(1_000);
		const owner = await Bun.file(path.join(PACKAGES_DIR, OWNER)).text();
		for (const host of HOSTS) expect(owner).toContain(`"https://${host}"`);
		for (const endpoint of PATH_ENDPOINTS) expect(owner).toContain(`"${endpoint}"`);
	});

	/**
	 * The modules that used to declare a host now import one. A module that had quietly gone back to a
	 * literal would still pass the case above if the literal were spelled differently, so this asserts the
	 * positive: each former declarer takes its host from the owner.
	 */
	it("has every former declarer importing from the owner", async () => {
		const formerDeclarers = [
			"catalog/src/provider-models/google.ts",
			"ai/src/providers/google-gemini-cli.ts",
			"ai/src/usage/gemini.ts",
			"ai/src/usage/google-antigravity.ts",
			"ai/src/registry/oauth/google-antigravity.ts",
			"ai/src/registry/oauth/google-gemini-cli.ts",
			"coding-agent/src/web/search/providers/gemini.ts",
			"coding-agent/src/tools/image-gen.ts",
			"coding-agent/src/session/agent-session.ts",
			"catalog/src/discovery/gitlab-duo-workflow.ts",
			"ai/src/providers/gitlab-duo.ts",
			"ai/src/providers/gitlab-duo-workflow.ts",
			"ai/src/registry/oauth/gitlab-duo.ts",
			"ai/src/registry/oauth/gitlab-duo-workflow.ts",
		];
		for (const file of formerDeclarers) {
			const text = await Bun.file(path.join(PACKAGES_DIR, file)).text();
			expect(text).toMatch(/from "(?:@veyyon\/catalog|\.\.)\/provider-endpoints";/);
		}
	});

	/**
	 * The owner is a leaf on purpose. The whole reason ten modules retyped a string is that the existing
	 * export sat behind arktype and the discovery machinery, so if this module ever grew an import the same
	 * pressure would come back and the next module would copy the literal again.
	 */
	it("imports nothing, so taking a host costs one module", async () => {
		const owner = await Bun.file(path.join(PACKAGES_DIR, OWNER)).text();
		// The PARSED specifier list, not the characters: the scan this replaced also went red on a doc
		// comment containing `from "..."`, and on a free `import type`, which costs nothing at runtime.
		expect(moduleSpecifiersIn(owner)).toEqual([]);
	});
});
