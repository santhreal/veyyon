/**
 * Pressing stop is not a provider failure, and the record must not say it was.
 *
 * WHY THIS FILE EXISTS. A provider catch block runs for two unrelated reasons: the
 * request failed, or the caller cancelled it. Devin's terminal record graded both the
 * same way, at `error`, so four of twenty-two recorded `devin: stream failed` lines in
 * the local corpus were cancellations. That is not a cosmetic level: the log is what a
 * triage reads to find the eighteen real failures, and a red record for the one outcome
 * the operator explicitly asked for is exactly the noise that makes the file useless.
 *
 * THE CLASS. Not "devin logs an abort loudly" but "a terminal provider record grades
 * itself from something other than the finalized outcome". The fact that decides it
 * already exists: `finalize` computes `aborted` to produce `stopReason`, so the level
 * belongs beside it and is derived from the same fact. Two records can then never
 * disagree — an `aborted` result cannot be filed at `error`, whatever a call site writes.
 *
 * WHAT IS ASSERTED. That `finalize` grades every way an abort can be established, and
 * only those, keyed by exact equality against the stop reasons it can return; and that
 * the real Devin provider, driven end to end over a scripted Cascade stream, files a
 * cancellation at `debug` and a server refusal at `error`.
 *
 * WHAT IT DOES NOT CATCH. A provider that writes its own terminal record without
 * consulting `finalize` at all: nothing here can see a level that was never derived.
 * Devin is the only provider that logs a terminal stream failure today, and this pins
 * that one. It also says nothing about which failures are retried, which is the subject
 * of `devin-transient-stream-failures-are-retried.test.ts`.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import * as AIError from "@veyyon/ai/error";
import { streamDevin } from "@veyyon/ai/providers/devin";
import type { AssistantMessage, Context, Model } from "@veyyon/ai/types";
import { createAbortSourceTracker } from "@veyyon/ai/utils/abort";
import { buildModel } from "@veyyon/catalog/build";
import { GetChatMessageResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import { GetUserJwtResponseSchema } from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import { StopReason } from "@veyyon/catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";
import { logger } from "@veyyon/utils";

/**
 * The one decision this file defends, as data: which stop reason is filed how loud.
 *
 * Keyed by exact equality below, so a third terminal outcome cannot be added without a
 * level being chosen for it here.
 */
const EXPECTED_LEVEL: Record<"aborted" | "error", "debug" | "error"> = {
	aborted: "debug",
	error: "error",
};

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const CONNECT_END_STREAM_FLAG = 0x02;

function dataFrame(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	new DataView(out.buffer).setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

function textFrame(text: string, stopReason = StopReason.UNSPECIFIED): Uint8Array {
	const msg = create(GetChatMessageResponseSchema, { messageId: "msg-1", stopReason, deltaText: text });
	return dataFrame(toBinary(GetChatMessageResponseSchema, msg));
}

/** The end-stream trailer, which is where Cascade reports a stream-level failure. */
function errorTrailer(code: string, message: string): Uint8Array {
	const json = new TextEncoder().encode(JSON.stringify({ error: { code, message } }));
	const out = new Uint8Array(5 + json.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, CONNECT_END_STREAM_FLAG);
	view.setUint32(1, json.length, false);
	out.set(json, 5);
	return out;
}

/** A Cascade transport that replays one scripted attempt, and answers the auth call. */
function scriptedFetch(frames: readonly Uint8Array[]): typeof fetch {
	const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	return (async (input: string | URL | Request) => {
		if (String(input).includes("GetUserJwt")) return new Response(authPayload);
		let index = 0;
		return new Response(
			new ReadableStream<Uint8Array>({
				pull(controller) {
					const frame = frames[index++];
					if (frame) controller.enqueue(frame);
					else controller.close();
				},
			}),
			{ status: 200 },
		);
	}) as typeof fetch;
}

interface Recorded {
	level: "debug" | "warn" | "error";
	message: string;
}

/** Every record the provider wrote, at whichever level it chose. */
function recordLogger(): { records: Recorded[] } {
	const records: Recorded[] = [];
	for (const level of ["debug", "warn", "error"] as const) {
		spyOn(logger, level).mockImplementation((message: string) => {
			records.push({ level, message });
		});
	}
	return { records };
}

async function runDevin(
	frames: readonly Uint8Array[],
	options: { signal?: AbortSignal } = {},
): Promise<AssistantMessage> {
	const stream = streamDevin(devinModel, context, {
		apiKey: "token",
		fetch: scriptedFetch(frames),
		signal: options.signal,
		// Retries are another file's subject; waiting for real is not this file's cost.
		providerRetryWait: async () => {},
	});
	for await (const _event of stream) void _event;
	return await stream.result();
}

afterEach(() => {
	// Restored per test rather than left in place: a leaked logger stub silences every later file.
	vi.restoreAllMocks();
});

describe("finalize grades a terminal outcome once, for every caller", () => {
	/**
	 * Every way an abort can be established, swept rather than sampled.
	 *
	 * There are three: a bare caller signal, a tracker whose caller signal aborted, and a
	 * tracker that aborted locally (a watchdog), which is NOT the caller's intent and so
	 * must still read as a failure. Sampling one of them is how the next one ships wrong.
	 */
	it("derives the level from the same fact as the stop reason, on every abort path", async () => {
		const abortedCaller = new AbortController();
		abortedCaller.abort();
		const trackerAborted = createAbortSourceTracker(abortedCaller.signal);
		const trackerLocal = createAbortSourceTracker();
		trackerLocal.abortLocally(new Error("first-token watchdog"));

		// Each case names the outcome it must produce, not merely that the two fields agree. A
		// mutant that treats a local watchdog abort as the caller's intent kept them agreeing
		// (both flipped together) and survived until these expectations pinned the value.
		const cases = [
			{ name: "no abort at all", opts: {}, stopReason: "error" },
			{ name: "bare caller signal aborted", opts: { signal: abortedCaller.signal }, stopReason: "aborted" },
			{ name: "tracker reports a caller abort", opts: { abortTracker: trackerAborted }, stopReason: "aborted" },
			{
				name: "tracker aborted locally, not by the caller",
				opts: { abortTracker: trackerLocal },
				stopReason: "error",
			},
		] as const;

		const seen = new Set<string>();
		for (const testCase of cases) {
			const result = await AIError.finalize(new Error("backend unavailable"), testCase.opts);
			seen.add(result.stopReason);
			expect(result.stopReason, testCase.name).toBe(testCase.stopReason);
			expect(result.logLevel, testCase.name).toBe(EXPECTED_LEVEL[testCase.stopReason]);
		}

		// Fail by default: a third terminal stop reason turns this red until a level is chosen
		// for it in EXPECTED_LEVEL, and a path that stops producing one is caught the same way.
		expect([...seen].sort()).toEqual(Object.keys(EXPECTED_LEVEL).sort());
	});
});

describe("a devin turn files its terminal record at the level the outcome earns", () => {
	/**
	 * The cancellation. This is the record that was wrong: the operator pressed stop, the
	 * catch block ran, and a red line went into the log for it.
	 */
	it("records a caller cancellation quietly", async () => {
		const { records } = recordLogger();
		const controller = new AbortController();
		controller.abort();

		const result = await runDevin([errorTrailer("unavailable", "backend unavailable")], {
			signal: controller.signal,
		});

		const terminal = records.filter(record => record.message === "devin: stream failed");
		expect(terminal).toEqual([{ level: "debug", message: "devin: stream failed" }]);
		expect(result.stopReason).toBe("aborted");
	});

	/**
	 * The failure, which must stay loud. A level fix that quiets the real ones has moved the
	 * defect rather than closed it, so this is the other half of the same assertion.
	 */
	it("records a server refusal loudly", async () => {
		const { records } = recordLogger();

		const result = await runDevin([errorTrailer("invalid_argument", "tool schema is not acceptable")]);

		const terminal = records.filter(record => record.message === "devin: stream failed");
		expect(terminal).toEqual([{ level: "error", message: "devin: stream failed" }]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("tool schema is not acceptable");
	});

	/**
	 * A turn that ended cleanly writes no terminal record at all. Without this a stub that
	 * graded everything `debug` would pass both rows above by never being wrong out loud.
	 */
	it("says nothing about a turn that finished", async () => {
		const { records } = recordLogger();

		const result = await runDevin([textFrame("done", StopReason.STOP_PATTERN)]);

		expect(records.filter(record => record.message === "devin: stream failed")).toEqual([]);
		expect(result.stopReason).toBe("stop");
	});
});
