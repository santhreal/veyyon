/**
 * A credential or model-resolution failure must name a remedy the READER can perform.
 *
 * TWO DEFECTS THIS PINS.
 *
 * 1. NO REMEDY AT ALL. Nine sites threw the bare sentence `No API key for
 *    anthropic/claude-opus-4-8`. That is the most frequent hard stop a fresh
 *    install hits and it named nothing to do about it, so the operator's next
 *    move was a search rather than a fix.
 *
 * 2. A REMEDY THE READER CANNOT PERFORM, which is worse, because it ends the
 *    search at a dead end. Two sites said "run `veyyon auth` to sign in" and
 *    `veyyon auth` is not a command: `cli-commands.ts` registers `auth-broker`
 *    and `auth-gateway`, and a bare `veyyon auth` hits the near-miss guard whose
 *    own doc comment cites it as the leak example. Three branches of
 *    `describeModelResolutionFailure` sent the reader to `/login` or `/model`,
 *    which are TUI-only slash commands, while its FIRST caller is `main.ts`
 *    throwing at CLI startup and `bench-cli.ts` and `veyyon commit` reach it too.
 *
 * WHY THE COMMAND CHECK IS DERIVED FROM THE REGISTRY. Asserting the literal
 * string `veyyon auth-broker login` would pass forever after the command is
 * renamed. Every `veyyon <sub>` token these messages emit is looked up in the
 * real `commands` table instead, so a rename or removal fails here rather than
 * shipping a dead instruction. That is the check that would have caught `veyyon
 * auth`.
 *
 * EVERY BRANCH, NOT THE ONE I WAS LOOKING AT. The remedy assertions run over
 * all five `ModelResolutionFailureKind` branches and over every provider in the
 * catalog, because both defects lived in branches nobody exercised.
 */

import { describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@veyyon/ai/oauth";
import { CATALOG_PROVIDERS, type ProviderCatalogEntry } from "@veyyon/catalog/provider-models";
import { commands } from "@veyyon/coding-agent/cli-commands";
import { credentialRemedySentence, missingCredentialsMessage } from "@veyyon/coding-agent/config/missing-credentials";
import {
	describeModelResolutionFailure,
	type ModelResolutionFailureKind,
} from "@veyyon/coding-agent/config/model-resolution-failure";
import { fallbackForUnavailableDefault } from "@veyyon/coding-agent/config/model-resolver";
import { ModelsConfigFile } from "@veyyon/coding-agent/config/models-config";

/** Every top-level subcommand name and alias the CLI actually routes. */
const REGISTERED_COMMANDS: ReadonlySet<string> = new Set(
	commands.flatMap(entry => [entry.name, ...(entry.aliases ?? [])]),
);

/**
 * The `veyyon <sub>` names a message instructs the reader to run that the CLI
 * does not route. This is the check that would have caught `veyyon auth`.
 */
function unroutableSubcommandsIn(text: string): string[] {
	return [...text.matchAll(/veyyon ([a-z][a-z0-9-]*)/g)]
		.map(match => match[1] as string)
		.filter(name => !REGISTERED_COMMANDS.has(name));
}

/**
 * A slash command named as the ONLY route. The repo's convention, enforced for
 * slash-command output by `test/slash-commands/client-surface-parity.test.ts`,
 * is that naming a TUI-only command is acceptable only when the sentence says
 * which surface it lives on. These messages reach CLI readers, so the same rule
 * applies and the same qualifier phrase excuses it.
 */
function namesSlashCommandWithoutSayingWhere(text: string): boolean {
	if (!/(?:^|[\s(`])\/(login|model)\b/.test(text)) return false;
	return !text.includes("in an interactive veyyon session");
}

const CATALOG = ["anthropic/claude-opus-4-8", "openai/gpt-5.5", "google/gemini-3.1-pro-preview"];

describe("missingCredentialsMessage", () => {
	it("names the provider's real environment variable, the login command, and the config key", () => {
		expect(missingCredentialsMessage("anthropic", "claude-opus-4-8")).toBe(
			"No API key for anthropic/claude-opus-4-8. Fix: set ANTHROPIC_API_KEY in the environment, " +
				"run `veyyon auth-broker login anthropic` to sign in " +
				"(`/login anthropic` in an interactive veyyon session), " +
				`or set providers.anthropic.apiKey in ${ModelsConfigFile.path()}.`,
		);
	});

	/**
	 * The env-var clause is read from the catalog, not written down. `anthropic`
	 * is the case that proves it matters: `getEnvApiKeyName` returns undefined for
	 * it (its resolver is a `$pickenv` over the Foundry, OAuth and plain
	 * variables), so a message built on that function alone named no variable for
	 * the single most frequently configured provider.
	 */
	it("names both variables for a provider whose catalog entry lists two", () => {
		expect(missingCredentialsMessage("huggingface", "deepseek-ai/DeepSeek-R1")).toContain(
			"set HUGGINGFACE_HUB_TOKEN or HF_TOKEN in the environment",
		);
	});

	/**
	 * A provider whose credentials are a CHAIN rather than a variable gets no env
	 * clause. The failure this guards is a fabricated one: inventing
	 * `AMAZON_BEDROCK_API_KEY` would read as a remedy and set nothing.
	 */
	it("omits the environment clause for a provider with no env variable, and does not dangle the conjunction", () => {
		const message = missingCredentialsMessage("amazon-bedrock", "us.anthropic.claude-opus-4-8");
		expect(message).not.toContain("in the environment");
		expect(message).not.toContain("Fix: or ");
		expect(message).toBe(
			"No API key for amazon-bedrock/us.anthropic.claude-opus-4-8. " +
				`Fix: set providers.amazon-bedrock.apiKey in ${ModelsConfigFile.path()}.`,
		);
	});

	/** The operation is named, so a failed model switch reads differently from a failed handoff. */
	it("names the operation that could not start", () => {
		expect(missingCredentialsMessage("openai", "gpt-5.5", "the handoff summary model")).toStartWith(
			"No API key for the handoff summary model (openai/gpt-5.5). Fix: set OPENAI_API_KEY in the environment,",
		);
	});

	it("omits the login clause for a provider with no OAuth flow", () => {
		const oauthIds = new Set(getOAuthProviders().map(entry => entry.id));
		expect(oauthIds.has("openai")).toBe(false);
		expect(missingCredentialsMessage("openai", "gpt-5.5")).not.toContain("auth-broker login");
	});

	/**
	 * Every provider, because both defects fixed here lived in a branch nobody
	 * exercised. A message that names an unroutable subcommand is the exact
	 * `veyyon auth` failure, and the bound is asserted for every provider rather
	 * than for the one that happened to be long.
	 */
	it("names only routable subcommands and stays bounded, for every provider in the catalog", () => {
		const hostileModelId = "m".repeat(5000);
		for (const entry of CATALOG_PROVIDERS as readonly ProviderCatalogEntry[]) {
			const message = missingCredentialsMessage(entry.id, hostileModelId, "x".repeat(5000));
			expect(unroutableSubcommandsIn(message)).toEqual([]);
			expect(namesSlashCommandWithoutSayingWhere(message)).toBe(false);
			expect(message).toContain("Fix: ");
			expect(message.length).toBeLessThanOrEqual(600);
		}
	});

	/**
	 * The TOTAL ceiling, exercised by the one input the per-part caps do not
	 * cover. A provider id is interpolated into the config-key clause
	 * (`providers.<id>.apiKey`) uncapped, and a provider id is not a fixed set:
	 * `models.yml` names its own custom providers, and a model selector supplies
	 * one. Bounding only the model id and the operation label left the whole
	 * message unbounded through that clause, which is the same "per-field caps
	 * that never compose into a total" shape as the 50,437-character validation
	 * failure.
	 */
	it("bounds the whole message when the PROVIDER id is the oversized part", () => {
		const message = missingCredentialsMessage("p".repeat(50_000), "gpt-5.5");
		expect(message.length).toBeLessThanOrEqual(600);
		expect(message).toStartWith("No API key for ppp");
	});

	it("gives the remedy sentence alone to a caller that stated the failure itself", () => {
		expect(credentialRemedySentence("openai")).toBe(
			`Fix: set OPENAI_API_KEY in the environment, or set providers.openai.apiKey in ${ModelsConfigFile.path()}.`,
		);
	});
});

describe("describeModelResolutionFailure remedies", () => {
	/**
	 * One case per branch, so the loop below covers the whole enum rather than the
	 * branch a reader happened to open. `registry-error` is the one branch that
	 * legitimately names no command: nothing about the request can be concluded
	 * when the registry itself failed to load, and it says so.
	 */
	const CASES: ReadonlyArray<{
		kind: ModelResolutionFailureKind;
		context: Parameters<typeof describeModelResolutionFailure>[0];
	}> = [
		{
			kind: "registry-error",
			context: { requested: ["opus"], allModelIds: CATALOG, availableModelIds: [], registryError: "bad yaml" },
		},
		{ kind: "empty-registry", context: { requested: ["opus"], allModelIds: [], availableModelIds: [] } },
		{ kind: "no-credentials", context: { requested: ["opus"], allModelIds: CATALOG, availableModelIds: [] } },
		{
			kind: "provider-unauthenticated",
			context: {
				requested: ["claude-opus-4-8"],
				allModelIds: CATALOG,
				availableModelIds: ["openai/gpt-5.5"],
			},
		},
		{
			kind: "unknown-model",
			context: { requested: ["totally-made-up"], allModelIds: CATALOG, availableModelIds: CATALOG },
		},
	];

	it("classifies each case as the branch it is meant to exercise", () => {
		expect(CASES.map(entry => describeModelResolutionFailure(entry.context).kind)).toEqual(
			CASES.map(entry => entry.kind),
		);
	});

	it("names no subcommand the CLI does not route, in any branch", () => {
		for (const entry of CASES) {
			const { message } = describeModelResolutionFailure(entry.context);
			expect(unroutableSubcommandsIn(message)).toEqual([]);
		}
	});

	it("never sends the reader to a TUI-only slash command without saying it is the interactive route", () => {
		for (const entry of CASES) {
			const { message } = describeModelResolutionFailure(entry.context);
			expect(namesSlashCommandWithoutSayingWhere(message)).toBe(false);
		}
	});

	it("tells an unauthenticated provider exactly which login to run", () => {
		const { message } = describeModelResolutionFailure({
			requested: ["claude-opus-4-8"],
			allModelIds: CATALOG,
			availableModelIds: ["openai/gpt-5.5"],
		});
		expect(message).toBe(
			'"claude-opus-4-8" exists but has no usable credentials for anthropic. The model id is correct. ' +
				"Fix: run `veyyon auth-broker login anthropic`, or set that provider's API key environment variable " +
				"(`/login` in an interactive veyyon session).",
		);
	});

	it("points an unmatched id at the command that lists what is available", () => {
		const { message } = describeModelResolutionFailure({
			requested: ["totally-made-up"],
			allModelIds: CATALOG,
			availableModelIds: CATALOG,
		});
		expect(message).toBe(
			'Model "totally-made-up" not found among 3 model(s) with usable credentials. ' +
				"Run `veyyon models` to list them (`/model` in an interactive veyyon session).",
		);
	});
});

describe("fallbackForUnavailableDefault", () => {
	const AVAILABLE = [{ provider: "openai", id: "gpt-5.5" }] as unknown as Parameters<
		typeof fallbackForUnavailableDefault
	>[1];

	/**
	 * This warning is printed by `veyyon commit`, `--print` startup and `bench`
	 * as well as the interactive session, and it named `veyyon auth`, which does
	 * not exist, plus `/model`, which those three readers cannot open.
	 */
	it("names the configured provider's login command and the CLI listing", () => {
		expect(fallbackForUnavailableDefault("anthropic/claude-opus-4-8", AVAILABLE)?.warning).toBe(
			'Configured default model "anthropic/claude-opus-4-8" is unavailable: its provider has no stored ' +
				"credentials or the model no longer exists. Using openai/gpt-5.5 instead. Fix: run " +
				"`veyyon auth-broker login anthropic` to sign in, or `veyyon models` to see what is available " +
				"(`/model` picks a new default in an interactive veyyon session).",
		);
	});

	/** A bare model id names no provider, so the clause stays a placeholder rather than guessing. */
	it("does not invent a provider when the configured selector carries none", () => {
		const warning = fallbackForUnavailableDefault("opus", AVAILABLE)?.warning ?? "";
		expect(warning).toContain("`veyyon auth-broker login <provider>`");
		expect(unroutableSubcommandsIn(warning)).toEqual([]);
	});
});
