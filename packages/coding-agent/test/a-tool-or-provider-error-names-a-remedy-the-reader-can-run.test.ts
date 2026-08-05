/**
 * A tool or provider credential error must name a remedy the READER can perform.
 *
 * THE CONFIRMED DEFECT CLASS, extended. An earlier pass fixed the credential and
 * model-resolution messages that said `veyyon auth` (not a command) or named
 * `/login` and `/model` to a CLI reader; `test/config/a-credential-error-names-a-
 * remedy-you-can-run.test.ts` pins those. It left four sites behind, in three
 * files, all of the same shape:
 *
 *  - `tools/tts.ts` said `Run /login -> xAI Grok OAuth (SuperGrok or X Premium+)
 *    or set XAI_API_KEY.` Its sibling `tools/image-gen.ts` had the identical
 *    sentence and was corrected; this twin was not. `/login` carries no
 *    `textMode: true`, so it is a TUI menu, and the arrow named a submenu entry
 *    rather than an argument. The first reader of a tool error is the MODEL,
 *    which can open no menu.
 *  - `providers/gitlab-duo.ts` said `Run /login gitlab-duo or set GITLAB_TOKEN.`
 *  - `providers/google-gemini-cli.ts` said `Use /login to re-authenticate.` at
 *    three sites, with NO alternative at all. A headless run, an ACP client and
 *    the model were each told to do the one thing they cannot do.
 *
 * THE RULE THIS ENFORCES, which is the repo's own. Naming a TUI-only slash
 * command is acceptable only when the sentence says which surface it lives on,
 * with the phrase `in an interactive veyyon session`. Naming a `veyyon <sub>` is
 * acceptable only when `cli-commands.ts` routes it. Both checks read the real
 * tables, so a rename fails here rather than shipping a dead instruction.
 *
 * WHY THE PROVIDER MESSAGES ARE REACHED THROUGH THEIR REAL THROW PATHS. Asserting
 * an exported constant would not prove the sentence reaches anyone.
 * `parseGeminiCliCredentials` is called with a real malformed credential and the
 * thrown message is read off the error.
 */

import { describe, expect, it } from "bun:test";
import { parseGeminiCliCredentials } from "@veyyon/ai/providers/google-gemini-cli";
import { commands } from "@veyyon/coding-agent/cli-commands";
import { missingXAICredentialsMessage } from "@veyyon/coding-agent/lib/xai-http";
import { BUILTIN_SLASH_COMMAND_DECLARATIONS } from "@veyyon/coding-agent/slash-commands/builtin-declarations";
import { errorMessage } from "@veyyon/utils";

const REGISTERED_COMMANDS: ReadonlySet<string> = new Set(
	commands.flatMap(entry => [entry.name, ...(entry.aliases ?? [])]),
);

/** Slash commands with no `textMode: true`, i.e. reachable only from the TUI. */
const TUI_ONLY_SLASH_COMMANDS: ReadonlySet<string> = new Set(
	BUILTIN_SLASH_COMMAND_DECLARATIONS.filter(entry => entry.textMode !== true).map(entry => entry.name),
);

function unroutableSubcommandsIn(text: string): string[] {
	return [...text.matchAll(/veyyon ([a-z][a-z0-9-]*)/g)]
		.map(match => match[1] as string)
		.filter(name => !REGISTERED_COMMANDS.has(name));
}

/**
 * A TUI-only slash command named without saying where it lives. Derived from the
 * declaration table rather than a hand-written list of `login`/`model`, so a
 * command that LOSES `textMode: true` starts being checked here automatically.
 */
function tuiOnlyCommandsNamedWithoutSurface(text: string): string[] {
	if (text.includes("in an interactive veyyon session")) return [];
	return [...text.matchAll(/(?:^|[\s(`])\/([a-z][a-z-]*)/g)]
		.map(match => match[1] as string)
		.filter(name => TUI_ONLY_SLASH_COMMANDS.has(name));
}

/** Every message this test judges, each read from the code that produces it. */
function geminiMessages(): string[] {
	const messages: string[] = [];
	for (const raw of ["{not json", JSON.stringify({ access_token: "a" })]) {
		try {
			parseGeminiCliCredentials(raw);
			throw new Error(`expected parseGeminiCliCredentials to reject ${raw}`);
		} catch (error) {
			messages.push(errorMessage(error));
		}
	}
	return messages;
}

describe("/login is TUI-only, and the declaration table is what says so", () => {
	/**
	 * The premise every assertion below rests on. If `/login` ever gains
	 * `textMode: true` this fails, which is the signal to relax the rule rather
	 * than to keep asserting a stale one.
	 */
	it("carries no textMode, unlike /model and /mcp", () => {
		expect(TUI_ONLY_SLASH_COMMANDS.has("login")).toBe(true);
		expect(TUI_ONLY_SLASH_COMMANDS.has("model")).toBe(false);
		expect(TUI_ONLY_SLASH_COMMANDS.has("mcp")).toBe(false);
	});
});

describe("the Google Cloud Code Assist credential errors", () => {
	it("name a terminal command and qualify the slash command, at both parse failures", () => {
		const messages = geminiMessages();
		expect(messages).toHaveLength(2);
		for (const message of messages) {
			expect(message).toContain("Fix: run `veyyon auth-broker login google-gemini-cli`");
			expect(unroutableSubcommandsIn(message)).toEqual([]);
			expect(tuiOnlyCommandsNamedWithoutSurface(message)).toEqual([]);
		}
	});

	/**
	 * The two failures are different and read differently. Before this both said
	 * `Use /login to re-authenticate.`, so an operator could not tell a corrupt
	 * credential file from one missing a field, and would re-run the same login
	 * for both.
	 */
	it("distinguishes an unparseable credential from one missing a field", () => {
		const [unparseable, incomplete] = geminiMessages();
		expect(unparseable).toStartWith("The stored Google Cloud Code Assist credentials could not be parsed");
		expect(incomplete).toStartWith(
			"The stored Google Cloud Code Assist credentials are missing their token or projectId",
		);
	});
});

describe("the xAI tool credential error", () => {
	/**
	 * ONE OWNER, exercised directly. The sentence lived twice, in
	 * `tools/image-gen.ts` and `tools/tts.ts`, and the two copies had already
	 * drifted: image-gen's was corrected and tts's still said `Run /login -> xAI
	 * Grok OAuth`. It now lives beside `resolveXAIHttpCredentials`, the function
	 * whose `null` return is the failure, so both tools state the same thing and
	 * there is one place for this test to reach.
	 */
	it("names reachable commands and qualifies the TUI-only one", () => {
		const message = missingXAICredentialsMessage("speech cannot be synthesized");
		expect(unroutableSubcommandsIn(message)).toEqual([]);
		expect(tuiOnlyCommandsNamedWithoutSurface(message)).toEqual([]);
		expect(message).toBe(
			"No xAI credentials, so speech cannot be synthesized. " +
				"Fix: set XAI_API_KEY in the environment, or run `veyyon auth-broker login xai-oauth` to sign in with a " +
				"SuperGrok or X Premium+ account (`/login` in an interactive veyyon session). " +
				"Do not retry this tool until one of those is done; report the missing credential instead.",
		);
	});

	/**
	 * The MODEL's own next step, which the operator-facing credential messages do
	 * not need and a tool error does. A tool error with no stopping rule leaves
	 * the model two behaviours, calling the same tool again or abandoning the
	 * task, and a credential does not appear between two calls.
	 */
	it("tells the model to stop rather than retry", () => {
		expect(missingXAICredentialsMessage("no image can be generated")).toContain(
			"Do not retry this tool until one of those is done; report the missing credential instead.",
		);
	});

	/** The capability is named, so a failed tts call reads differently from a failed image generation. */
	it("names the capability that could not run", () => {
		expect(missingXAICredentialsMessage("no image can be generated")).toStartWith(
			"No xAI credentials, so no image can be generated.",
		);
	});
});
