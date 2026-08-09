/**
 * Every login flow that asks for a key asks for it masked, and the ones that ask for
 * configuration say so.
 *
 * WHY THIS SUITE EXISTS. `OAuthPrompt.secret` decides whether a UI echoes the answer, and exactly
 * one flow set it: `createApiKeyLogin`. The other seventeen prompts that ask you to paste a bearer
 * credential left it absent, so the key you pasted was drawn in clear text on whatever screen,
 * recording, or shoulder was there, and the pasted-authorization-code prompt did the same with a
 * value exchangeable for tokens. Nothing anywhere asserted the flag, so all of it was green.
 *
 * THE CLASS, not the incident. The reported shape was "one provider forgot the flag", and pinning
 * that provider would leave the other sixteen and every provider added next week. Two things close
 * it instead:
 *
 *   1. Absent now means MASKED at the consumers (`login-dialog.ts`, the setup wizard, the RPC
 *      frame). A flow that forgets the flag is safe, so forgetting is no longer the defect it was.
 *      That is asserted where those consumers live, in `packages/coding-agent`.
 *   2. This suite goes the other way and refuses a flow that says `secret: false` for something
 *      that reads as a credential. That is the only remaining spelling of the bug: not omission,
 *      but an explicit opt-out on the wrong prompt.
 *
 * DERIVED FROM THE REGISTRY at run time, so a provider added tomorrow is swept without anyone
 * remembering this file. The set of flows is `PROVIDER_REGISTRY`, not a list typed out here.
 *
 * WHAT IT DOES NOT CATCH, honestly. Each flow is driven until it asks something the harness has no
 * scripted answer for, with `fetch` stubbed to reject, so a prompt that only appears AFTER a
 * successful network round trip is not observed: Perplexity's emailed OTP is the one live example,
 * and it is configuration rather than a stored credential. A flow reached only through a real
 * provider handshake (a device-code poll that has to succeed first) is likewise unobserved here.
 * The consumer-side default is what covers those, which is the whole reason it is the default.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { setTimeout } from "node:timers/promises";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt } from "../src/registry/oauth/types";
import { PROVIDER_REGISTRY } from "../src/registry/registry";
import type { FetchImpl } from "../src/types";

/** What the harness answers, by the order a flow asks. Anything else stops the flow. */
const SCRIPTED_ANSWERS: readonly string[] = ["1", "sk-test-value", "sk-test-value", "sk-test-value"];

/** Thrown from `onPrompt` to end a flow that has asked everything the harness can answer. */
class StopFlow extends Error {}

/**
 * Words that mean the answer is credential material. Deliberately about what is being ASKED for
 * rather than about a provider: a new provider wording it "paste your token" is caught the same
 * way, and a prompt asking for an endpoint or an email matches none of them.
 */
const CREDENTIAL_WORDS: readonly RegExp[] = [/api key/i, /\btoken\b/i, /authorization code/i, /\bsecret\b/i];

function asksForACredential(prompt: OAuthPrompt): boolean {
	return CREDENTIAL_WORDS.some(word => word.test(prompt.message));
}

/** How long one flow gets to ask its questions before the sweep moves on to the next provider. */
const FLOW_BUDGET_MS = 250;

/** A `fetch` that refuses instantly, in the exact shape both the global and the option want. */
const CLOSED_NETWORK = Object.assign(
	async (): Promise<Response> => {
		throw new Error("network is closed in this suite");
	},
	{ preconnect: (): void => {} },
) as unknown as FetchImpl & typeof fetch;

/**
 * Drive one login and return every prompt it managed to ask.
 *
 * `fetch` is injected AND the global is stubbed, because a flow may reach for either, and a flow
 * that reaches the network in this suite must fail instantly rather than wait on a real provider.
 *
 * BOUNDED, because a login is written to wait: a device-code flow polls on a schedule and a
 * callback flow sits on a socket, and neither ends just because the network refused it. The signal
 * is aborted at the deadline, which is the cancellation every flow here already honours, and the
 * prompts asked before it stand as the observation.
 */
async function promptsAskedBy(
	login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials | string>,
): Promise<OAuthPrompt[]> {
	const asked: OAuthPrompt[] = [];
	const controller = new AbortController();
	const callbacks: OAuthLoginCallbacks = {
		onAuth: () => {},
		onProgress: () => {},
		onPrompt: async (prompt: OAuthPrompt) => {
			asked.push(prompt);
			const answer = SCRIPTED_ANSWERS[asked.length - 1];
			if (answer === undefined) throw new StopFlow("no scripted answer");
			return answer;
		},
		signal: controller.signal,
		fetch: CLOSED_NETWORK,
	};
	const driven = login(callbacks).then(
		() => undefined,
		() => undefined,
	);
	// Every flow here ends in a refusal: a stopped prompt, a rejected fetch, a rejected key, or the
	// deadline below. What it asked for on the way is the whole observation.
	await Promise.race([driven, setTimeout(FLOW_BUDGET_MS)]);
	controller.abort();
	return asked;
}

/** Every flow that carries a login, in registry order. */
const LOGIN_FLOWS = PROVIDER_REGISTRY.filter(
	(
		provider,
	): provider is typeof provider & { login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials | string> } =>
		provider.login !== undefined,
);

beforeEach(() => {
	// A flow may reach for the global rather than the injected one, and either must fail instantly.
	vi.spyOn(globalThis, "fetch").mockImplementation(CLOSED_NETWORK);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a login prompt for a credential is never offered unmasked", () => {
	test("the registry really does carry login flows to sweep", () => {
		// Without this, a broken filter would make every case below vacuous.
		expect(LOGIN_FLOWS.length).toBeGreaterThan(20);
	});

	test("no flow asks for a key, token, or authorization code with echoing allowed", async () => {
		const offenders: string[] = [];
		let credentialPromptsSeen = 0;
		for (const provider of LOGIN_FLOWS) {
			const asked = await promptsAskedBy(provider.login);
			for (const prompt of asked) {
				if (!asksForACredential(prompt)) continue;
				credentialPromptsSeen += 1;
				if (prompt.secret === false) offenders.push(`${provider.id}: ${prompt.message}`);
			}
		}
		expect(offenders).toEqual([]);
		// The sweep is only worth anything if it actually reached credential prompts.
		expect(credentialPromptsSeen).toBeGreaterThan(10);
	});

	test("the flows that ask for configuration declare it, so those fields stay readable", async () => {
		const alibaba = LOGIN_FLOWS.find(provider => provider.id === "alibaba-coding-plan");
		expect(alibaba).toBeDefined();
		if (!alibaba) return;
		const asked = await promptsAskedBy(alibaba.login);
		const endpointChoice = asked[0];
		expect(endpointChoice?.message).toContain("endpoint");
		expect(endpointChoice?.secret).toBe(false);
		// And the same flow's key prompt is not readable, so the opt-out is per prompt and not per flow.
		const keyPrompt = asked.find(prompt => asksForACredential(prompt));
		expect(keyPrompt).toBeDefined();
		expect(keyPrompt?.secret).toBe(true);
	});

	/**
	 * The API-key helper is the one owner every pasted-key provider goes through, so its prompt is
	 * asserted directly as well: a change there is a change to all of them at once.
	 */
	test("the shared API-key flow marks its prompt as a credential", async () => {
		const novita = LOGIN_FLOWS.find(provider => provider.id === "novita");
		expect(novita).toBeDefined();
		if (!novita) return;
		const asked = await promptsAskedBy(novita.login);
		expect(asked).toHaveLength(1);
		expect(asked[0]?.secret).toBe(true);
	});
});
