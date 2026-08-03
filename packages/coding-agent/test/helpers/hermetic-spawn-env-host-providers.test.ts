/**
 * The provider half of `hermeticSpawnEnv`, asserted directly on the environment it returns.
 *
 * WHY THIS SUITE EXISTS. Isolation from the host used to mean "a temp HOME and no config
 * redirects", which is isolation from the developer's FILES and nothing else. Two doors stayed
 * open and both were measured on a real workstation:
 *
 *   - a `SYNTHETIC_API_KEY` exported in the developer's shell was copied straight into every
 *     child through the `{ ...process.env }` spread;
 *   - `ollama`, `llama.cpp` and `lm-studio` are registered as optional discoverable providers on
 *     every launch with no credential and no config at all, at fixed loopback addresses, so a
 *     desk running Ollama handed a brand-new temp HOME a full working model.
 *
 * The consequence was a whole file of secret-stress cases that waited for the literal
 * "No models are available", timed out at 50s each here, and passed on CI. A test whose result is
 * decided by what the machine happens to be running is not a test, and the failure mode is
 * silent: it looks like flake, and the usual repair is to weaken the assertion.
 *
 * Everything below reads the returned env object. Nothing reads the helper's source text: the
 * contract is what the child receives, not how the file is written.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@veyyon/catalog/provider-models";
import { CONFIG_ROOT_ENV_KEYS, XDG_BASE_DIRS } from "../../../utils/test/helpers/isolated-config-root";
import { hermeticSpawnEnv } from "./hermetic-spawn-env";

/**
 * Every credential variable the catalog names, derived here from the catalog rather than from the
 * helper's own export.
 *
 * Reusing the helper's constant would make the central assertion circular: a derivation that
 * silently produced an empty list would satisfy "everything in the list is gone". Reading the same
 * upstream table independently is what makes "a provider added tomorrow is covered" a real claim.
 */
const CATALOG_CREDENTIAL_ENV_VARS: readonly string[] = [
	...new Set(
		(CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]).flatMap(provider => [
			...(provider.envVars ?? []),
			...(provider.catalogDiscovery?.envVars ?? []),
		]),
	),
];

/** Variables this file sets on the parent process, so every one is restored whatever happens. */
const touched: Record<string, string | undefined> = {};

function setParentEnv(key: string, value: string): void {
	if (!(key in touched)) touched[key] = process.env[key];
	process.env[key] = value;
}

afterEach(() => {
	for (const key of Object.keys(touched)) {
		const original = touched[key];
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
		delete touched[key];
	}
});

describe("hermeticSpawnEnv denies the host's providers", () => {
	/**
	 * The measured leak, in its narrowest form. `SYNTHETIC_API_KEY` was exported in the shell that
	 * ran the suite and reached the child verbatim, so an "isolated" root talked to a paid provider
	 * on the developer's account. Pins that the credential is gone from the CHILD env while the
	 * PARENT keeps it: a helper that fixed the leak by deleting the variable from `process.env`
	 * would break the developer's own session and every later test in the same runner.
	 */
	it("drops a provider credential exported in the parent process, without disturbing the parent", () => {
		setParentEnv("SYNTHETIC_API_KEY", "parent-shell-key-not-a-real-credential");

		const { env, cleanup } = hermeticSpawnEnv();
		try {
			expect(env.SYNTHETIC_API_KEY).toBeUndefined();
			expect(process.env.SYNTHETIC_API_KEY).toBe("parent-shell-key-not-a-real-credential");
		} finally {
			cleanup();
		}
	});

	/**
	 * The whole table, not one variable. The helper derives its list from `CATALOG_PROVIDERS`
	 * precisely so a provider added to the catalog is scrubbed with no edit here; this case is what
	 * turns that intent into a guarantee, because it sets EVERY name the catalog knows and demands
	 * that none survive. A hand-written list in the helper would fail the day it fell behind.
	 *
	 * The two spot checks are there so the case cannot pass vacuously: an empty derivation would
	 * make the loop below assert nothing at all.
	 */
	it("drops every credential variable the catalog names", () => {
		expect(CATALOG_CREDENTIAL_ENV_VARS).toContain("ANTHROPIC_API_KEY");
		expect(CATALOG_CREDENTIAL_ENV_VARS).toContain("SYNTHETIC_API_KEY");

		for (const key of CATALOG_CREDENTIAL_ENV_VARS) {
			setParentEnv(key, `host-value-for-${key}`);
		}

		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const survivors = CATALOG_CREDENTIAL_ENV_VARS.filter(key => env[key] !== undefined);
			expect(survivors).toEqual([]);
		} finally {
			cleanup();
		}
	});

	/**
	 * Credentials are only half of it: the local providers need none. This pins the exact endpoints
	 * a child is given, because "some other port" is not the contract. Port 0 is reserved and
	 * cannot be bound, so the child's discovery is refused by the kernel instead of depending on
	 * whether a server happens to be listening on 11434, 8080 or 1234 today.
	 *
	 * The parent values are set to the real defaults first, which is the state on the machine this
	 * suite was written on: the assertion is that the helper OVERRIDES a live local server, not
	 * merely that it fills in a blank.
	 */
	it("points every local-provider knob at the closed loopback port, overriding live host values", () => {
		setParentEnv("OLLAMA_BASE_URL", "http://127.0.0.1:11434");
		setParentEnv("OLLAMA_HOST", "127.0.0.1:11434");
		setParentEnv("LLAMA_CPP_BASE_URL", "http://127.0.0.1:8080");
		setParentEnv("LM_STUDIO_BASE_URL", "http://127.0.0.1:1234/v1");
		setParentEnv("LITELLM_BASE_URL", "http://localhost:4000/v1");

		const { env, cleanup } = hermeticSpawnEnv();
		try {
			expect(env.OLLAMA_BASE_URL).toBe("http://127.0.0.1:0");
			expect(env.OLLAMA_HOST).toBe("127.0.0.1:0");
			expect(env.LLAMA_CPP_BASE_URL).toBe("http://127.0.0.1:0");
			expect(env.LM_STUDIO_BASE_URL).toBe("http://127.0.0.1:0/v1");
			expect(env.LITELLM_BASE_URL).toBe("http://127.0.0.1:0/v1");
		} finally {
			cleanup();
		}
	});

	/**
	 * The claim the endpoint choice rests on, checked rather than asserted in a comment: a connect
	 * to the address the child is handed FAILS, and fails immediately. If a future edit swaps port
	 * 0 for a "probably free" high port, this is what notices the day something binds it.
	 */
	it("hands the child an endpoint that actually refuses a connection", async () => {
		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const baseUrl = env.OLLAMA_BASE_URL;
			// Named before it is used, so a helper that produced no value cannot pass this case by
			// making `fetch` reject on an unparseable URL instead of on a refused connection.
			expect(baseUrl).toBe("http://127.0.0.1:0");
			const started = Date.now();
			await expect(fetch(`${baseUrl}/api/tags`)).rejects.toThrow();
			expect(Date.now() - started).toBeLessThan(2_000);
		} finally {
			cleanup();
		}
	});

	/**
	 * The pre-existing half of the contract, re-asserted beside the new half so a future rewrite
	 * cannot trade one for the other. HOME must be a fresh temp directory and every config-root and
	 * XDG variable must be gone even when the parent exports them, because the XDG bases OUTRANK
	 * the config root per category and a temp HOME does not remove them.
	 */
	it("still swaps HOME for a temp dir and strips the config-root and XDG variables", () => {
		setParentEnv("VEYYON_PROFILE", "work");
		setParentEnv("VEYYON_CODING_AGENT_DIR", "/real/agent/dir");
		setParentEnv("XDG_STATE_HOME", "/real/state");

		const { home, env, cleanup } = hermeticSpawnEnv();
		try {
			expect(env.HOME).toBe(home);
			expect(home.startsWith(tmpdir())).toBe(true);
			expect(env.HOME).not.toBe(process.env.HOME);
			for (const key of [...CONFIG_ROOT_ENV_KEYS, ...XDG_BASE_DIRS]) {
				expect(env[key], key).toBeUndefined();
			}
		} finally {
			cleanup();
		}
	});

	/**
	 * The opt-in, which is load-bearing and easy to lose. Scrubbing is a DEFAULT, not a
	 * prohibition: `test/secrets/realterminalsecretstress-*.test.ts` passes a dummy
	 * `ANTHROPIC_API_KEY` into its `/secret` subcommand runs so the CLI can resolve a model
	 * registry before dispatching a slash command, and `OLLAMA_BASE_URL` is how a suite that wants
	 * a reachable stub endpoint would name one. If the scrub ever ran after `extra`, both would
	 * break with a failure that looks like a product bug.
	 */
	it("lets an explicit extra win over both the credential scrub and the endpoint override", () => {
		setParentEnv("ANTHROPIC_API_KEY", "host-key-not-a-real-credential");

		const { env, cleanup } = hermeticSpawnEnv({
			ANTHROPIC_API_KEY: "seeded-by-the-suite",
			OLLAMA_BASE_URL: "http://127.0.0.1:59999",
		});
		try {
			expect(env.ANTHROPIC_API_KEY).toBe("seeded-by-the-suite");
			expect(env.OLLAMA_BASE_URL).toBe("http://127.0.0.1:59999");
		} finally {
			cleanup();
		}
	});
});
