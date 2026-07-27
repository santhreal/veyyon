/**
 * The provider env-key OVERRIDES: the rules a variable name cannot express, and where they are allowed to live.
 *
 * WHY THIS SUITE EXISTS. Three providers find their credentials by probing the host rather than by reading one
 * named variable: Amazon Bedrock accepts five different AWS credential shapes, Vertex AI accepts an API key or
 * Application Default Credentials plus a project and a location, and Anthropic reorders its variable list when
 * Foundry mode is on. Those rules used to be functions on the provider DEFINITIONS, which meant `getEnvApiKey`
 * imported `./registry` (121 modules of login flows, transports and model lists, 95 of them marginal) to read one
 * field, and every one of the eighteen web-search providers in `@veyyon/coding-agent` carried it. They live in
 * `src/provider-env-keys.ts` now.
 *
 * WHAT MOVING A PROBE CAN BREAK WITHOUT ANYTHING FAILING TO COMPILE. A probe returns `undefined` when it finds
 * nothing, and `undefined` is also what an absent table entry returns, so a rule that stopped being consulted
 * looks exactly like a host with no credentials: the operator is told to log in when they are already
 * authenticated. Every branch of every probe is asserted below, in both directions, with the environment driven
 * rather than mocked, because the branch conditions ARE the contract.
 *
 * IT ALSO PINS WHERE THE RULES LIVE. Two ratchets: no provider definition may carry an `envKeys` field again (a
 * field nothing reads looks like configuration and does nothing), and no override may restate what the catalog
 * already says for the same id (`gitlab-duo-agent` did, spelling `GITLAB_TOKEN` twice under two names for one
 * fact, which is the same-value duplicate that drifts).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@veyyon/catalog/provider-models";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import { getEnvApiKey } from "../src/env-api-key";
import { PROVIDER_ENV_KEY_OVERRIDES, resetVertexAdcProbeForTests } from "../src/provider-env-keys";

const SRC = path.join(import.meta.dir, "..", "src");
const REGISTRY = path.join(SRC, "registry");

/**
 * Every AWS, Google and Anthropic variable the three probes read, cleared before each case.
 *
 * Listed rather than derived: the probes read these names, and a case that passed because the developer's own
 * shell happened to export `AWS_PROFILE` would be worthless. Clearing them all is what makes each case's
 * assertion about the variables it sets and nothing else.
 */
const DRIVEN = [
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_ROLE_ARN",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCP_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_VERTEX_LOCATION",
	"GOOGLE_CLOUD_LOCATION",
	"VERTEX_LOCATION",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_FOUNDRY_API_KEY",
	// The switch `isFoundryEnabled` reads. Named for upstream compatibility, not for veyyon.
	"CLAUDE_CODE_USE_FOUNDRY",
] as const;

let saved: Array<[string, string | undefined]> = [];

beforeEach(() => {
	saved = DRIVEN.map(name => [name, process.env[name]] as [string, string | undefined]);
	for (const name of DRIVEN) delete process.env[name];
	resetVertexAdcProbeForTests();
});

afterEach(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	resetVertexAdcProbeForTests();
});

/** A probe's answer, taken through the public lookup so the merge order is exercised with it. */
function resolve(provider: string): string | undefined {
	return getEnvApiKey(provider);
}

describe("the Amazon Bedrock credential probe", () => {
	/**
	 * Bedrock has no key variable, so the answer for an authenticated host is the `<authenticated>` sentinel:
	 * callers use it to decide whether to offer a login, and a raw secret here would be a credential printed
	 * into a UI that expects a marker.
	 */
	it.each([
		["a named profile", { AWS_PROFILE: "work" }],
		["an IAM key pair", { AWS_ACCESS_KEY_ID: "AKIA...", AWS_SECRET_ACCESS_KEY: "secret" }],
		["a bearer token", { AWS_BEARER_TOKEN_BEDROCK: "token" }],
		["the ECS relative-URI chain", { AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/creds" }],
		["the ECS full-URI chain", { AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/creds" }],
		["IRSA web identity", { AWS_WEB_IDENTITY_TOKEN_FILE: "/var/token", AWS_ROLE_ARN: "arn:aws:iam::1:role/r" }],
	])("reports authenticated for %s", (_label, env) => {
		Object.assign(process.env, env);

		expect(resolve("amazon-bedrock")).toBe("<authenticated>");
	});

	/** Nothing set is not authenticated, which is the case the sentinel is distinguished from. */
	it("reports nothing when no AWS credential is present", () => {
		expect(resolve("amazon-bedrock")).toBeUndefined();
	});

	/**
	 * THE BOUNDARY, and the one a rewrite gets wrong. An IAM pair needs BOTH halves and IRSA needs BOTH
	 * halves; either alone is a half-configured host, and reporting it authenticated sends the SDK to fail
	 * against a partial credential instead of prompting for the rest.
	 */
	it.each([
		["an access key with no secret", { AWS_ACCESS_KEY_ID: "AKIA..." }],
		["a secret with no access key", { AWS_SECRET_ACCESS_KEY: "secret" }],
		["a web-identity token with no role", { AWS_WEB_IDENTITY_TOKEN_FILE: "/var/token" }],
		["a role with no web-identity token", { AWS_ROLE_ARN: "arn:aws:iam::1:role/r" }],
	])("does not report authenticated for %s", (_label, env) => {
		Object.assign(process.env, env);

		expect(resolve("amazon-bedrock")).toBeUndefined();
	});
});

describe("the Google Vertex credential probe", () => {
	/** An explicit API key wins outright and is returned as the value, because for Vertex it really is one. */
	it("returns the explicit API key when one is set", () => {
		process.env.GOOGLE_CLOUD_API_KEY = "vertex-key-value";

		expect(resolve("google-vertex")).toBe("vertex-key-value");
	});

	/**
	 * The ADC path needs THREE things: credentials on disk, a project and a location. The probe reads the
	 * credentials from the filesystem, so the case points `GOOGLE_APPLICATION_CREDENTIALS` at a real file it
	 * creates; pointing it at a path that does not exist is the negative twin below.
	 */
	it("reports authenticated for ADC credentials with a project and a location", () => {
		const credentials = path.join(
			fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "vertex-adc-")),
			"application_default_credentials.json",
		);
		fs.writeFileSync(credentials, "{}");
		process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials;
		process.env.GOOGLE_CLOUD_PROJECT = "a-project";
		process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

		expect(resolve("google-vertex")).toBe("<authenticated>");
	});

	/**
	 * A credentials path that is not there is not authentication. This is the case a probe that stopped
	 * touching the filesystem would pass by accident, which is why it asserts the negative on a set variable
	 * rather than on an unset one.
	 */
	it("reports nothing when the credentials path does not exist", () => {
		process.env.GOOGLE_APPLICATION_CREDENTIALS = "/nonexistent/adc.json";
		process.env.GOOGLE_CLOUD_PROJECT = "a-project";
		process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

		expect(resolve("google-vertex")).toBeUndefined();
	});

	/**
	 * And the two halves that are easy to drop in a rewrite: credentials without a project, or without a
	 * location, is an incomplete Vertex configuration and the SDK cannot build a request from it.
	 */
	it.each([
		["no project", { GOOGLE_CLOUD_LOCATION: "us-central1" }],
		["no location", { GOOGLE_CLOUD_PROJECT: "a-project" }],
	])("reports nothing for ADC credentials with %s", (_label, env) => {
		const credentials = path.join(
			fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "vertex-adc-")),
			"application_default_credentials.json",
		);
		fs.writeFileSync(credentials, "{}");
		process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials;
		Object.assign(process.env, env);

		expect(resolve("google-vertex")).toBeUndefined();
	});

	/**
	 * Each of the three project variables and each of the three location variables is accepted, because the
	 * gcloud tooling sets different ones in different eras and a host is configured if ANY of them is set.
	 */
	it.each(["GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT"])("accepts %s as the project", projectVar => {
		const credentials = path.join(
			fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "vertex-adc-")),
			"application_default_credentials.json",
		);
		fs.writeFileSync(credentials, "{}");
		process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials;
		process.env[projectVar] = "a-project";
		process.env.VERTEX_LOCATION = "us-central1";

		expect(resolve("google-vertex")).toBe("<authenticated>");
	});

	it.each(["GOOGLE_VERTEX_LOCATION", "GOOGLE_CLOUD_LOCATION", "VERTEX_LOCATION"])(
		"accepts %s as the location",
		locationVar => {
			const credentials = path.join(
				fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "vertex-adc-")),
				"application_default_credentials.json",
			);
			fs.writeFileSync(credentials, "{}");
			process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials;
			process.env.GCP_PROJECT = "a-project";
			process.env[locationVar] = "us-central1";

			expect(resolve("google-vertex")).toBe("<authenticated>");
		},
	);
});

describe("the Anthropic variable order", () => {
	/**
	 * Ordinary mode reads the OAuth token before the API key, because a logged-in Pro/Max session is the
	 * credential the user chose most recently. Both set is the case that proves an ORDER rather than a
	 * presence check.
	 */
	it("prefers the OAuth token over the API key", () => {
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
		process.env.ANTHROPIC_API_KEY = "api-key";

		expect(resolve("anthropic")).toBe("oauth-token");
	});

	it("falls back to the API key when no OAuth token is set", () => {
		process.env.ANTHROPIC_API_KEY = "api-key";

		expect(resolve("anthropic")).toBe("api-key");
	});

	/**
	 * Foundry mode puts the enterprise gateway variable FIRST, which is the whole reason this rule cannot be
	 * a static list: the same provider reads a different variable depending on a runtime setting. With all
	 * three set, the answer names which mode is in effect.
	 */
	it("prefers the Foundry gateway key when Foundry mode is enabled", () => {
		process.env.CLAUDE_CODE_USE_FOUNDRY = "1";
		process.env.ANTHROPIC_FOUNDRY_API_KEY = "foundry-key";
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
		process.env.ANTHROPIC_API_KEY = "api-key";

		expect(resolve("anthropic")).toBe("foundry-key");
	});

	/**
	 * And the control: the same three variables without Foundry mode give the OAuth token, so the case above
	 * is about the mode and not about the variable merely existing.
	 */
	it("ignores the Foundry gateway key when Foundry mode is off", () => {
		process.env.ANTHROPIC_FOUNDRY_API_KEY = "foundry-key";
		process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-token";
		process.env.ANTHROPIC_API_KEY = "api-key";

		expect(resolve("anthropic")).toBe("oauth-token");
	});
});

describe("the ADC probe's process cache", () => {
	/**
	 * The filesystem check is cached for the process, because it runs on every key lookup and
	 * `gcloud auth application-default login` is something you do before starting veyyon. The cache is
	 * asserted rather than assumed: a probe that re-read the disk every time would be a syscall on a hot
	 * path, and one that cached the WRONG answer would report an authenticated host forever.
	 */
	it("answers from the cache until it is reset", () => {
		const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "vertex-adc-cache-"));
		const credentials = path.join(dir, "application_default_credentials.json");
		fs.writeFileSync(credentials, "{}");
		process.env.GOOGLE_APPLICATION_CREDENTIALS = credentials;
		process.env.GCP_PROJECT = "a-project";
		process.env.VERTEX_LOCATION = "us-central1";

		expect(resolve("google-vertex")).toBe("<authenticated>");
		fs.rmSync(credentials);
		// Still authenticated: the answer came from the cache, which is the behaviour being pinned.
		expect(resolve("google-vertex")).toBe("<authenticated>");

		resetVertexAdcProbeForTests();

		expect(resolve("google-vertex")).toBeUndefined();
	});
});

describe("where an env-key rule is allowed to live", () => {
	/**
	 * THE RATCHET THAT KEEPS THE CUT. A provider definition carrying an `envKeys` field is no longer read by
	 * anything: `getEnvApiKey` takes the overrides from this table, so a field written back onto a definition
	 * would be configuration that does nothing, and the provider would silently fall back to its catalog
	 * entry or to no key at all. `ProviderDefinition` no longer declares the field, so `satisfies` catches
	 * most of it, but a definition written without the `satisfies` clause would not be caught by the compiler
	 * at all. Source scan, so the failure names the file.
	 */
	it("has no provider definition still declaring an envKeys field", () => {
		const offenders: string[] = [];
		for (const entry of fs.readdirSync(REGISTRY, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
			const source = fs.readFileSync(path.join(REGISTRY, entry.name), "utf-8");
			if (/^\t*envKeys\s*:/m.test(source)) offenders.push(entry.name);
		}

		expect(offenders.sort()).toEqual([]);
	});

	/**
	 * NON-VACUITY for the scan above: the same reader, pointed at this table, finds the rules. A scan whose
	 * pattern stopped matching would report zero offenders forever.
	 */
	it("finds the rules where they now live, so the scan is not blind", () => {
		const source = fs.readFileSync(path.join(SRC, "provider-env-keys.ts"), "utf-8");

		expect(source).toContain('"amazon-bedrock": amazonBedrockEnvKey');
		expect(Object.keys(PROVIDER_ENV_KEY_OVERRIDES).length).toBeGreaterThanOrEqual(13);
	});

	/**
	 * THE ONE PLACE RATCHET. An override for a provider the catalog already describes with the SAME single
	 * variable is one fact written twice: `gitlab-duo-agent` declared `envKeys: "GITLAB_TOKEN"` while the
	 * catalog's `envVars` said `["GITLAB_TOKEN"]`, and the override silently won. Byte-identical copies
	 * drift, and the reader of either has no way to know the other exists.
	 *
	 * A computed override for a catalogued provider is fine and is the point of the layer (`anthropic`), so
	 * only string overrides are checked.
	 */
	it("has no string override that merely restates the catalog", () => {
		const catalog = new Map(
			(CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]).map(provider => [provider.id, provider.envVars ?? []]),
		);
		const restated: string[] = [];
		for (const [id, resolver] of Object.entries(PROVIDER_ENV_KEY_OVERRIDES)) {
			if (typeof resolver !== "string") continue;
			const fromCatalog = catalog.get(id);
			if (fromCatalog?.length === 1 && fromCatalog[0] === resolver) {
				restated.push(`${id} says ${resolver} here and in the catalog`);
			}
		}

		expect(restated.sort()).toEqual([]);
	});

	/**
	 * And the catalog still answers for the provider whose duplicate was removed, which is the half that
	 * makes the removal safe rather than merely tidy. `gitlab-duo-agent` must still resolve `GITLAB_TOKEN`,
	 * through the catalog layer alone.
	 */
	it("still resolves the provider whose duplicate override was deleted", () => {
		const previous = process.env.GITLAB_TOKEN;
		try {
			process.env.GITLAB_TOKEN = "gitlab-token-value";

			expect(resolve("gitlab-duo-agent")).toBe("gitlab-token-value");
		} finally {
			if (previous === undefined) delete process.env.GITLAB_TOKEN;
			else process.env.GITLAB_TOKEN = previous;
		}
	});

	/**
	 * The table is a leaf by construction: the environment reader, the Foundry switch, and node's filesystem
	 * for the ADC probe. An import of `./registry` or of the streaming engine here would put the cost back
	 * exactly where it was removed from, four hops from a web-search provider.
	 */
	it("imports nothing but the environment reader, the Foundry switch and node built-ins", () => {
		const specifiers = moduleSpecifiersIn(fs.readFileSync(path.join(SRC, "provider-env-keys.ts"), "utf-8"));

		expect(specifiers.sort()).toEqual(
			["@veyyon/utils/env", "./utils/foundry", "node:fs", "node:os", "node:path"].sort(),
		);
	});
});
