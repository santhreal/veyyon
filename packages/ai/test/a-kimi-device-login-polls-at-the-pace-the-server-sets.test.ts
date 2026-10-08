/**
 * A Kimi device-code login polls the token endpoint until it answers with a token, waiting between polls
 * at the pace the server sets, and stops on the first answer that ends the flow.
 *
 * Class closed: every token-endpoint answer the flow distinguishes (`authorization_pending`, `slow_down`
 * with and without a server interval, `expired_token`, `access_denied`, an unknown error code, an error
 * with no code) maps to its own wait or its own error. The waits are read from the stubbed
 * `scheduler.wait`, so a wait that is skipped, kept after `slow_down`, or taken after a terminal answer
 * shows as a different wait list.
 *
 * Not caught: the real elapsed time of a wait (the stub returns at once), and the deadline, which no
 * answer here reaches.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { OAuthError } from "@veyyon/ai/error";
import { loginKimi } from "@veyyon/ai/registry/oauth/kimi";

afterEach(() => {
	vi.restoreAllMocks();
});

type TokenAnswer = { status: number; body: Record<string, unknown> };

const TOKEN: TokenAnswer = {
	status: 200,
	body: { access_token: "kimi-access", refresh_token: "kimi-refresh", expires_in: 3600 },
};
const PENDING: TokenAnswer = { status: 400, body: { error: "authorization_pending" } };

interface LoginRun {
	waits: number[];
	polls: number;
	outcome: { access: string; refresh: string } | { error: string };
}

async function runLogin(answers: TokenAnswer[], deviceIntervalSeconds: number): Promise<LoginRun> {
	const waits: number[] = [];
	let polls = 0;
	vi.spyOn(scheduler, "wait").mockImplementation(async (ms: number) => {
		waits.push(ms);
	});
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith("/api/oauth/device_authorization")) {
			return Response.json({
				user_code: "ABCD-1234",
				device_code: "device-1",
				verification_uri: "https://www.kimi.com/code/authorize_device",
				interval: deviceIntervalSeconds,
				expires_in: 900,
			});
		}
		if (url.endsWith("/api/oauth/token")) {
			const answer = answers[polls++];
			if (!answer) throw new Error("polled past the scripted answers");
			return Response.json(answer.body, { status: answer.status });
		}
		throw new Error(`unexpected request: ${url}`);
	}) as typeof fetch);

	try {
		const credentials = await loginKimi({});
		return { waits, polls, outcome: { access: credentials.access, refresh: credentials.refresh } };
	} catch (error) {
		if (!(error instanceof OAuthError)) throw error;
		return { waits, polls, outcome: { error: error.message } };
	}
}

describe("a Kimi device login polls at the pace the server sets", () => {
	it("waits the device interval after each pending answer and returns the token it is given", async () => {
		const run = await runLogin([PENDING, PENDING, TOKEN], 2);
		expect(run).toEqual({
			waits: [2000, 2000],
			polls: 3,
			outcome: { access: "kimi-access", refresh: "kimi-refresh" },
		});
	});

	it("never polls faster than once a second", async () => {
		const run = await runLogin([PENDING, TOKEN], 0.25);
		expect(run.waits).toEqual([1000]);
	});

	it("adds five seconds to the wait on every slow_down and keeps the longer wait afterwards", async () => {
		const slowDown: TokenAnswer = { status: 400, body: { error: "slow_down" } };
		const run = await runLogin([slowDown, PENDING, slowDown, TOKEN], 2);
		expect(run.waits).toEqual([7000, 7000, 12000]);
	});

	it("waits the server's slow_down interval when it is longer than the five-second step", async () => {
		const longer: TokenAnswer = { status: 400, body: { error: "slow_down", interval: 30 } };
		const shorter: TokenAnswer = { status: 400, body: { error: "slow_down", interval: 3 } };
		const run = await runLogin([longer, shorter, TOKEN], 2);
		expect(run.waits).toEqual([30000, 35000]);
	});

	const terminal: { name: string; answer: TokenAnswer; error: string }[] = [
		{
			name: "an expired device code",
			answer: { status: 400, body: { error: "expired_token" } },
			error: "Kimi device authorization expired",
		},
		{
			name: "a denied authorization",
			answer: { status: 400, body: { error: "access_denied" } },
			error: "Kimi device authorization denied",
		},
		{
			name: "an unknown error code",
			answer: { status: 400, body: { error: "invalid_client", error_description: "client is disabled" } },
			error: "Kimi device flow failed: invalid_client: client is disabled",
		},
		{
			name: "an error with no code",
			answer: { status: 503, body: {} },
			error: "Kimi device flow failed: 503",
		},
	];

	for (const { name, answer, error } of terminal) {
		it(`stops on ${name} without another wait or poll`, async () => {
			const run = await runLogin([PENDING, answer, TOKEN], 2);
			expect(run).toEqual({ waits: [2000], polls: 2, outcome: { error } });
		});
	}
});
