/**
 * A credential handshake cannot outlive the budget its caller declared.
 *
 * WHY THIS SUITE EXISTS. `no-api-outlives-the-budget-its-caller-declared.test.ts`
 * sweeps every API against a silent transport, and it deliberately hands each
 * probe working credentials (static AWS keys, an explicit Vertex access token)
 * so the sweep reaches the transport at all. That leaves the credential phase
 * unexercised: the phase that runs BEFORE the first byte and dials its own
 * endpoints, which is where the shape of the last real stall defect lived.
 *
 * Both shared resolvers cap themselves at 30s (`SHARED_RESOLVE_TIMEOUT_MS` in
 * aws-credentials, `SHARED_TOKEN_RESOLVE_TIMEOUT_MS` in google-auth) and
 * deliberately detach that work from any one caller's signal, because the
 * resolution is single-flighted and shared between concurrent callers. Nothing
 * inside the handshake honors a caller's `streamFirstEventTimeoutMs`. What
 * bounds the TURN is one layer up: `register-builtins.ts` wraps every
 * registered provider's stream in the first-event watchdog whose failure reads
 * `Provider stream timed out while waiting for the first event`, and a
 * credential handshake runs before the provider pushes its first event, so the
 * watchdog is still armed while it is outstanding.
 *
 * THE CLASS IT CLOSES. "A pre-first-event phase escapes the watchdog that is
 * supposed to bound it." That is not hypothetical: `gitlab-duo-agent` is
 * dispatched straight at its module and never reaches `register-builtins`, so
 * its six-call REST handshake ran with nothing over it and overran a declared
 * 500ms budget past 5s until it was given its own setup deadline. These two
 * arms are the same question asked of the credential handshakes: Vertex ADC
 * resolution (OAuth token exchange or metadata server) and the AWS chain
 * (`credential_process`, and by construction the SSO federation fetch and IMDS,
 * which take the same signal through `resolveFresh`). A provider that stops
 * being registered, pushes its first event before resolving credentials, or
 * moves the handshake behind its own unbounded await turns these red.
 *
 * WHAT IT DOES NOT CATCH. The caller stopping is not the handshake stopping:
 * the detached shared resolution keeps running to its own 30s ceiling for other
 * concurrent callers, by design, so a leaked dial after the turn ends is
 * invisible here and intended. Neither arm pins WHICH deadline wins, only that
 * one does inside the bound - a provider that grew its own credential fence
 * would stay green, which is correct, since the contract is termination inside
 * the declared budget rather than the identity of the timer.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { stream } from "@veyyon/ai/stream";
import type { Api, AssistantMessageEventStream, Context, Model, StreamOptions } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { $env } from "@veyyon/utils/env";
import { __resetVertexTokenCache } from "../src/providers/google-auth";
import { fetchThatNeverAnswers } from "./helpers/silent-transport";

/** What the caller declares. Small, so an ignored budget cannot hide in slack. */
const DECLARED_BUDGET_MS = 400;

/**
 * How long past the declared budget the turn may take to surface. A handshake
 * that escapes every bound falls back to its own 30s ceiling and misses this by
 * an order of magnitude, which is what makes the bound safe on a real clock.
 */
const BOUND_MS = 3_000;

/**
 * Where both probe models point. Port 9 (discard) is reserved and nothing on it
 * can answer, so a provider that ignored `options.fetch` and reached the
 * network is a hang here rather than a quiet pass against a real endpoint.
 */
const DEAD_ENDPOINT_URL = "http://127.0.0.1:9/v1";

const context: Context = { messages: [{ role: "user", content: "probe", timestamp: 1 }] };

/**
 * `stream()` is generic over the API and these probes hold two of them, so the
 * union is cast once here rather than at each call site.
 */
type StreamCall = (model: Model<Api>, context: Context, options: StreamOptions) => AssistantMessageEventStream;
const callStream = stream as unknown as StreamCall;

const savedEnv = new Map<string, string | undefined>();

function pinEnv(key: string, value: string | undefined): void {
	if (!savedEnv.has(key)) savedEnv.set(key, $env[key]);
	if (value === undefined) delete ($env as Record<string, string | undefined>)[key];
	else $env[key] = value;
}

let scratchDir: string;

beforeEach(async () => {
	scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-credential-budget-"));
	__resetVertexTokenCache();
});

afterEach(async () => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete ($env as Record<string, string | undefined>)[key];
		else $env[key] = value;
	}
	savedEnv.clear();
	__resetVertexTokenCache();
	await fs.rm(scratchDir, { recursive: true, force: true });
});

interface TurnObservation {
	/** The turn reached a terminal state rather than the suite's own bound. */
	terminated: boolean;
	/** It did so inside {@link BOUND_MS}. */
	withinBound: boolean;
	/** The surfaced failure names a deadline rather than a configuration problem. */
	namesDeadline: boolean;
}

/**
 * Drive one turn to its terminal state, or to the bound.
 *
 * A real clock, deliberately: the subject is a credential handshake that stalls
 * on a socket or on a child process, and the claim is wall-clock termination.
 * Fake timers cannot drive either, and a handshake that escapes its bound
 * misses this by 27 seconds, not by scheduling noise.
 */
async function observeTurn(model: Model<Api>, options: StreamOptions): Promise<TurnObservation> {
	const started = Date.now();
	const settle = async (): Promise<string> => {
		try {
			const events = callStream(model, context, options);
			for await (const _event of events) {
				// Drain: the failure arrives as a terminal event or as a rejection.
			}
			const message = await events.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				return message.errorMessage ?? `stopReason:${message.stopReason}`;
			}
			return "COMPLETED";
		} catch (error) {
			return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		}
	};
	const overrun = Promise.withResolvers<string>();
	const timer = setTimeout(() => overrun.resolve("OVERRAN"), BOUND_MS);
	try {
		const detail = await Promise.race([settle(), overrun.promise]);
		return {
			terminated: detail !== "OVERRAN",
			withinBound: Date.now() - started <= BOUND_MS,
			namesDeadline: /timed out|timeout|abort/i.test(detail),
		};
	} finally {
		clearTimeout(timer);
	}
}

describe("a credential handshake cannot outlive the declared budget", () => {
	it("ends the turn when the Vertex ADC token exchange goes quiet", async () => {
		const adcPath = path.join(scratchDir, "adc.json");
		// `authorized_user` reaches the OAuth token endpoint with no signing step,
		// so the stall lands on the exchange itself rather than on key parsing.
		await fs.writeFile(
			adcPath,
			JSON.stringify({
				type: "authorized_user",
				client_id: "probe-client",
				client_secret: "probe-secret",
				refresh_token: "probe-refresh",
			}),
		);
		pinEnv("GOOGLE_APPLICATION_CREDENTIALS", adcPath);
		// Every source that would short-circuit ADC resolution, cleared: an
		// explicit access token or an API key never reaches the token endpoint.
		pinEnv("GOOGLE_CLOUD_ACCESS_TOKEN", undefined);
		pinEnv("CLOUDSDK_AUTH_ACCESS_TOKEN", undefined);
		pinEnv("GOOGLE_CLOUD_API_KEY", undefined);
		pinEnv("VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS", undefined);

		const model = buildModel({
			id: "gemini-3.1-pro-preview",
			name: "gemini-3.1-pro-preview",
			api: "google-vertex",
			provider: "google-vertex",
			baseUrl: DEAD_ENDPOINT_URL,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		}) as Model<Api>;

		const observed = await observeTurn(model, {
			// The sentinel is what the agent loop passes for an ADC-authenticated
			// provider, and it is what routes this turn onto the token exchange.
			apiKey: "<authenticated>",
			project: "probe-project",
			location: "us-central1",
			fetch: fetchThatNeverAnswers(),
			streamFirstEventTimeoutMs: DECLARED_BUDGET_MS,
			streamIdleTimeoutMs: DECLARED_BUDGET_MS,
		} as StreamOptions);

		expect(observed).toEqual({ terminated: true, withinBound: true, namesDeadline: true });
	});

	it("ends the turn when the Bedrock credential process hangs", async () => {
		const credentialsPath = path.join(scratchDir, "aws-credentials");
		// A profile name unique per run: `resolveAwsCredentials` keeps a
		// process-wide in-flight map, and the stalled resolution stays in it for
		// its full ceiling after this caller gives up.
		const profile = `probe-hang-${process.pid}-${Date.now()}`;
		await fs.writeFile(credentialsPath, `[${profile}]\ncredential_process = /bin/sh -c "sleep 5"\n`);
		pinEnv("AWS_SHARED_CREDENTIALS_FILE", credentialsPath);
		pinEnv("AWS_CONFIG_FILE", path.join(scratchDir, "aws-config-absent"));
		// Every earlier link of the AWS chain, cleared, so the profile is reached.
		pinEnv("AWS_ACCESS_KEY_ID", undefined);
		pinEnv("AWS_SECRET_ACCESS_KEY", undefined);
		pinEnv("AWS_SESSION_TOKEN", undefined);
		pinEnv("AWS_BEARER_TOKEN_BEDROCK", undefined);
		pinEnv("AWS_BEDROCK_SKIP_AUTH", undefined);
		pinEnv("AWS_REGION", "us-east-1");
		pinEnv("AWS_EC2_METADATA_DISABLED", "true");
		pinEnv("VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS", undefined);

		const model = buildModel({
			id: "us.anthropic.claude-sonnet-4-6",
			name: "claude-sonnet-4-6",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: DEAD_ENDPOINT_URL,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_000,
		}) as Model<Api>;

		const observed = await observeTurn(model, {
			apiKey: "<authenticated>",
			profile,
			region: "us-east-1",
			fetch: fetchThatNeverAnswers(),
			streamFirstEventTimeoutMs: DECLARED_BUDGET_MS,
			streamIdleTimeoutMs: DECLARED_BUDGET_MS,
		} as StreamOptions);

		expect(observed).toEqual({ terminated: true, withinBound: true, namesDeadline: true });
	});
});
