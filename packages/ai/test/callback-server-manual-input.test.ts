import { describe, expect, it } from "bun:test";
import { OAuthCallbackFlow } from "@veyyon/ai/registry/oauth/callback-server";
import type { OAuthCredentials } from "@veyyon/ai/registry/oauth/types";

class TestCallbackFlow extends OAuthCallbackFlow {
	/** The state this flow minted, captured the way a provider redirect echoes it back. */
	issuedState = "";

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		this.issuedState = state;
		return { url: `${redirectUri}?start=1&state=${state}` };
	}

	async exchangeToken(code: string, _state: string, _redirectUri: string): Promise<OAuthCredentials> {
		return {
			access: `access-${code}`,
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
	}
}

/**
 * Drive `login()` against a scripted list of pasted values. Each entry is a function so it can
 * read `flow.issuedState`, which only exists once `generateAuthUrl` has run.
 */
function runWithPastes(
	port: number,
	attempts: ((flow: TestCallbackFlow) => string)[],
): { flow: TestCallbackFlow; login: Promise<OAuthCredentials>; promptCount: () => number } {
	let promptCount = 0;
	const flow: TestCallbackFlow = new TestCallbackFlow(
		{
			onAuth: () => {},
			onManualCodeInput: async () => {
				const value = attempts[promptCount];
				promptCount += 1;
				if (!value) throw new Error("unexpected extra manual input request");
				return value(flow);
			},
			signal: AbortSignal.timeout(1_000),
		},
		port,
	);
	return { flow, login: flow.login(), promptCount: () => promptCount };
}

describe("OAuthCallbackFlow manual input retries", () => {
	it("retries manual input until a valid callback payload is provided", async () => {
		const run = runWithPastes(14555, [
			() => "http://localhost/callback?state=missing-code",
			f => `http://localhost/callback?code=valid-code&state=${f.issuedState}`,
		]);

		const credentials = await run.login;

		expect(run.promptCount()).toBe(2);
		expect(credentials.access).toBe("access-valid-code");
	});

	it("retries when manual callback state does not match", async () => {
		const run = runWithPastes(14556, [
			() => "http://localhost/callback?code=first-code&state=wrong-state",
			f => `http://localhost/callback?code=second-code&state=${f.issuedState}`,
		]);

		const credentials = await run.login;

		expect(run.promptCount()).toBe(2);
		expect(credentials.access).toBe("access-second-code");
	});

	/**
	 * WHY: the manual-paste arm used to skip the state comparison whenever the pasted value
	 * carried no `state` at all, so a bare `?code=...` was accepted and bound to this login. An
	 * attacker who talks an operator into pasting an authorization code they obtained links the
	 * operator's veyyon to the attacker's provider account. The served callback handler already
	 * refused the same input; the two halves now agree.
	 */
	it("refuses a pasted callback that carries no state, then accepts the one that does", async () => {
		const run = runWithPastes(14557, [
			() => "http://localhost/callback?code=attacker-code",
			() => "attacker-code",
			f => `http://localhost/callback?code=operator-code&state=${f.issuedState}`,
		]);

		const credentials = await run.login;

		expect(run.promptCount()).toBe(3);
		expect(credentials.access).toBe("access-operator-code");
	});

	it("accepts a bare code paste when the fragment carries the issued state", async () => {
		const run = runWithPastes(14558, [f => `raw-code#${f.issuedState}`]);

		const credentials = await run.login;

		expect(run.promptCount()).toBe(1);
		expect(credentials.access).toBe("access-raw-code");
	});
});
