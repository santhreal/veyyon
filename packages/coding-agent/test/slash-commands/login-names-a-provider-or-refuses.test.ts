/**
 * What `/login <text>` and `/logout <text>` do with an argument that is not an exact provider id.
 *
 * THE CLASS. Both commands resolved their argument with `provider.id === args`, an exact,
 * case-sensitive match against one of the two spellings the product shows. Everything else fell
 * through to a single catch-all: for `/login` the pasted-callback path, which answered
 * `No OAuth login is waiting for a manual callback.` So `/login Anthropic`, `/login Claude`,
 * `/login openrouter` (an API-key provider) and `/login gpt-9` all produced the same sentence about
 * a subsystem the operator never mentioned, with no next step in it. `/logout` refused honestly but
 * accepted only the id, so the two halves of one account surface disagreed about what a provider is
 * called.
 *
 * WHAT THIS SUITE PINS, and why each case is a separate member rather than one representative:
 *
 *  1. Every OAuth provider is reachable by its ID and by its DISPLAY NAME, enumerated from
 *     `getOAuthProviders()` at run time. A provider added to the registry is covered the moment it
 *     exists; a hardcoded list of three would leave the fourth untested, which is the failure mode
 *     the original bug had.
 *  2. Every provider that has NO login is refused with a credential remedy and never with the
 *     callback sentence, enumerated from `PROVIDER_REGISTRY` the same way.
 *  3. Text that is neither gets the alternatives, and a callback-shaped string with nothing pending
 *     keeps the manual-callback message that is true for exactly that case.
 *  4. A refusal starts NO login. A message that reads well while the selector opens anyway would
 *     pass a text-only assertion.
 *
 * WHAT IT DOES NOT CATCH. It drives the command handlers with a fake `InteractiveModeContext`, so
 * it proves which context call each argument produces and not what the selector then renders; the
 * card that a successful login lands on is proven in
 * `test/modes/controllers/a-command-login-lands-in-the-account-manager.test.ts` against the real
 * controller. It also says nothing about whether a provider's login FLOW works, only about routing.
 */

import { describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import { PROVIDER_REGISTRY } from "@veyyon/ai/registry";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

interface Recorder {
	readonly runtime: TuiSlashCommandRuntime;
	/** `[mode, providerId]` for every selector the command opened. */
	readonly selectors: Array<[string, string | undefined]>;
	readonly warnings: string[];
	readonly statuses: string[];
	readonly submitted: string[];
}

/**
 * A runtime whose context records the calls the handlers make.
 *
 * `pendingProvider` is the provider a manual callback is waiting for, which is the one piece of
 * state that legitimately changes what non-provider text MEANS: with a login waiting it is that
 * login's callback, and with none waiting it cannot be.
 */
function recorder(pendingProvider?: string): Recorder {
	const selectors: Array<[string, string | undefined]> = [];
	const warnings: string[] = [];
	const statuses: string[] = [];
	const submitted: string[] = [];
	let pending = pendingProvider;
	const runtime = {
		ctx: {
			editor: { setText: () => {} },
			oauthManualInput: {
				hasPending: () => pending !== undefined,
				get pendingProviderId() {
					return pending;
				},
				submit: (value: string) => {
					if (pending === undefined) return false;
					pending = undefined;
					submitted.push(value);
					return true;
				},
			},
			showOAuthSelector: async (mode: string, providerId?: string) => {
				selectors.push([mode, providerId]);
			},
			showWarning: (message: string) => {
				warnings.push(message);
			},
			showStatus: (message: string) => {
				statuses.push(message);
			},
		},
	} as unknown as TuiSlashCommandRuntime;
	return { runtime, selectors, warnings, statuses, submitted };
}

/**
 * Run `/login <args>` or `/logout <args>` through the real TUI dispatcher.
 *
 * The dispatcher rather than the handler, because the routing under test is not only the handler
 * body: `executeBuiltinSlashCommand` resolves the name through the same lookup the composer uses
 * and refuses an argument when the declaration forgot `allowArgs`. A handler called directly would
 * pass while `/login anthropic` was silently rejected one layer up, which is a shape this product
 * has shipped before. `true` is the dispatcher's "consumed entirely"; anything else is a routing
 * failure and is surfaced here rather than swallowed into an empty recorder.
 */
async function run(name: "login" | "logout", args: string, calls: Recorder): Promise<void> {
	const text = args.length > 0 ? `/${name} ${args}` : `/${name}`;
	const handled = await executeBuiltinSlashCommand(text, calls.runtime);
	if (handled !== true) throw new Error(`/${name} did not consume ${JSON.stringify(text)}: got ${String(handled)}`);
}

/** The OAuth providers `/login` may start, straight from the registry so a new one joins the suite. */
const oauthProviders = getOAuthProviders();

/**
 * Providers that exist and cannot be logged in to. `login` absent is the registry's own definition
 * of "authenticates with an API key" (see ProviderDefinition), so this list is derived, not curated.
 */
const apiKeyProviders = PROVIDER_REGISTRY.filter(provider => !provider.login);

const CALLBACK_SENTENCE = "No OAuth login is waiting for a manual callback.";

describe("/login resolves its argument", () => {
	it("has providers to test", () => {
		// A registry that resolved to nothing would make every loop below vacuously green.
		expect(oauthProviders.length).toBeGreaterThan(3);
		expect(apiKeyProviders.length).toBeGreaterThan(0);
	});

	it("starts a login for every provider id", async () => {
		for (const provider of oauthProviders) {
			const calls = recorder();
			await run("login", provider.id, calls);
			expect(calls.selectors).toEqual([["login", provider.id]]);
			expect(calls.warnings).toEqual([]);
		}
	});

	/**
	 * The display name is what the account card, the model hub and the login picker all show, so it
	 * is the spelling an operator reads before they type. Refusing it while printing it everywhere
	 * is the asymmetry this closes.
	 */
	it("starts a login for every provider display name", async () => {
		for (const provider of oauthProviders) {
			const calls = recorder();
			await run("login", provider.name, calls);
			expect(calls.selectors).toEqual([["login", provider.id]]);
		}
	});

	it("ignores case and separators in a provider id", async () => {
		const provider = oauthProviders[0]!;
		for (const spelling of [
			provider.id.toUpperCase(),
			`  ${provider.id}  `,
			provider.id.replace(/-/g, "_"),
			provider.id.replace(/-/g, " "),
		]) {
			const calls = recorder();
			await run("login", spelling, calls);
			expect(calls.selectors).toEqual([["login", provider.id]]);
		}
	});

	/**
	 * An API-key provider is a real provider, so the answer is how to give it a credential, not a
	 * sentence about OAuth callbacks. The remedy comes from the same builder every other
	 * missing-credential message uses, so it names the env var this provider actually reads.
	 */
	it("refuses a provider that has no browser login, with its credential remedy", async () => {
		for (const provider of apiKeyProviders) {
			const calls = recorder();
			await run("login", provider.id, calls);
			expect(calls.selectors).toEqual([]);
			expect(calls.warnings).toHaveLength(1);
			const warning = calls.warnings[0]!;
			expect(warning).toContain("no browser login");
			expect(warning).toContain("Fix:");
			expect(warning).not.toContain(CALLBACK_SENTENCE);
		}
	});

	it("refuses an unknown name by listing the providers that would have worked", async () => {
		const calls = recorder();
		await run("login", "gpt-9-turbo-max", calls);

		expect(calls.selectors).toEqual([]);
		expect(calls.warnings).toHaveLength(1);
		expect(calls.warnings[0]).toContain('Unknown provider "gpt-9-turbo-max"');
		for (const provider of oauthProviders) {
			expect(calls.warnings[0]).toContain(provider.id);
		}
	});

	/**
	 * The one case the old catch-all was actually right about: a pasted redirect with no login
	 * waiting. Keeping this sentence for exactly this shape is what makes it informative again.
	 */
	it("keeps the manual-callback message for callback-shaped text with nothing pending", async () => {
		for (const pasted of ["http://localhost:1455/callback?code=abc123", "?code=abc123&state=xyz", "code=abc123"]) {
			const calls = recorder();
			await run("login", pasted, calls);
			expect(calls.selectors).toEqual([]);
			expect(calls.warnings).toEqual([`${CALLBACK_SENTENCE} Start one with /login <provider>.`]);
		}
	});

	/** With a login waiting, arbitrary text IS the callback, and that path must still work. */
	it("submits arbitrary text as the callback while a login waits for one", async () => {
		const calls = recorder("anthropic");
		await run("login", "http://localhost:1455/callback?code=abc123", calls);

		expect(calls.submitted).toEqual(["http://localhost:1455/callback?code=abc123"]);
		expect(calls.statuses).toEqual(["OAuth callback received; completing login…"]);
		expect(calls.warnings).toEqual([]);
	});

	/** A provider named while another login is mid-flight is a collision, not a second login. */
	it("refuses to start a second login while one is waiting for its callback", async () => {
		const calls = recorder("anthropic");
		await run("login", oauthProviders[0]!.id, calls);

		expect(calls.selectors).toEqual([]);
		expect(calls.warnings[0]).toContain("already in progress");
	});

	it("opens the picker when no argument is given", async () => {
		const calls = recorder();
		await run("login", "", calls);

		expect(calls.selectors).toEqual([["login", undefined]]);
	});
});

describe("/logout resolves its argument the same way", () => {
	it("accepts every provider id and display name", async () => {
		for (const provider of oauthProviders) {
			for (const spelling of [provider.id, provider.name, provider.id.toUpperCase()]) {
				const calls = recorder();
				await run("logout", spelling, calls);
				expect(calls.selectors).toEqual([["logout", provider.id]]);
			}
		}
	});

	it("refuses an unknown name without opening a selector", async () => {
		const calls = recorder();
		await run("logout", "gpt-9-turbo-max", calls);

		expect(calls.selectors).toEqual([]);
		expect(calls.warnings[0]).toContain('Unknown provider "gpt-9-turbo-max"');
	});

	/**
	 * Logging out of an API-key provider is not a thing veyyon can do, and the remedy is different
	 * from the login one: there is no stored row to delete, only an env var or a config file the
	 * operator owns. Saying "unknown provider" about a provider that plainly exists is the lie.
	 */
	it("tells an API-key provider apart from an unknown one", async () => {
		const calls = recorder();
		await run("logout", apiKeyProviders[0]!.id, calls);

		expect(calls.selectors).toEqual([]);
		expect(calls.warnings[0]).toContain("no stored login to remove");
	});
});
