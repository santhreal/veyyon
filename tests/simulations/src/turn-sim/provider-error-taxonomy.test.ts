/**
 * Every class of provider failure, and what the session is allowed to do about it.
 *
 * WHY THIS FILE EXISTS. `provider-goes-quiet.test.ts` next door pins one
 * retryable error and one permanent one, which proves the mechanism exists and
 * says nothing about the taxonomy. The taxonomy is where the damage is: a
 * permanent failure that gets retried spends the whole budget before the
 * operator learns anything, and when the permanent failure is a BILLING one
 * (`402 ... depleted your monthly included credits`) each extra attempt is
 * another request against a credential that has already run out. A retryable
 * failure that is treated as permanent is the same defect from the other side: a
 * 503 that would have cleared on the next attempt ends the turn instead.
 *
 * So every error shape a real provider actually returns gets a row here, with the
 * one decision that matters recorded next to it: may this be resampled? A new
 * shape means a new row, which is a decision somebody makes, rather than a case
 * the suite quietly stops covering.
 *
 * The rows are the spec, deliberately. Deriving them from the classifier would
 * assert the classifier agrees with itself; here the expectation is written down
 * independently and the run says whether the product matches it.
 *
 * Two axes, because a stream that has already emitted content takes a different
 * path from one that fails before its first event: the partial answer has to
 * survive in the transcript, and the retry decision must not change because of
 * it.
 *
 * Determinism: no sleeps. The harness's retry backoff is 1-2ms and the budget is
 * two attempts, so a cell that retries forever fails as a test timeout.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { createSimulation, lastAssistantText, type Simulation } from "./harness";
import { describeViolations, turnViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** The retry budget the harness installs: two retries after the first attempt. */
const RETRY_BUDGET = 2;
const ANSWER = "answered on the attempt that worked";

interface ErrorRow {
	readonly name: string;
	/** What the provider says. Real wire text, because that is what gets classified. */
	readonly message: string;
	/** May the session resample this, or is another attempt guaranteed to fail too? */
	readonly resampleable: boolean;
}

const ERROR_ROWS: readonly ErrorRow[] = [
	{ name: "429 rate limit", message: "429 Too Many Requests: rate limit exceeded", resampleable: true },
	{ name: "500 internal", message: "500 Internal Server Error", resampleable: true },
	{ name: "502 bad gateway", message: "502 Bad Gateway", resampleable: true },
	{ name: "503 unavailable", message: "503 Service Unavailable: upstream overloaded", resampleable: true },
	{ name: "504 gateway timeout", message: "504 Gateway Timeout", resampleable: true },
	{ name: "529 overloaded", message: "529 Overloaded: the service is temporarily overloaded", resampleable: true },
	{ name: "http2 stream reset", message: "stream error: NGHTTP2_INTERNAL_ERROR", resampleable: true },
	{ name: "connection reset", message: "read ECONNRESET", resampleable: true },
	{ name: "connect timeout", message: "connect ETIMEDOUT 10.0.0.1:443", resampleable: true },
	{ name: "401 bad credential", message: "401 Unauthorized: invalid api key", resampleable: false },
	{ name: "403 forbidden", message: "403 Forbidden: your account cannot access this model", resampleable: false },
	{
		name: "402 depleted credits",
		message: "402 Payment Required: You have depleted your monthly included credits",
		resampleable: false,
	},
	{
		name: "400 malformed request",
		message: "400 Bad Request: messages.1: tool_use ids must be unique",
		resampleable: false,
	},
	{ name: "404 unknown model", message: "404 Not Found: model does not exist", resampleable: false },
];

/** Whether the turn had already streamed something when the failure landed. */
const ARRIVALS = ["before any content", "after partial text"] as const;

function lastAssistant(simulation: Simulation): AssistantMessage {
	const assistants = simulation.session.messages.filter(
		(message): message is AssistantMessage => message.role === "assistant",
	);
	const tail = assistants.at(-1);
	if (!tail) throw new Error("no assistant message in the transcript");
	return tail;
}

/** A distinguishing fragment of the row's own text, for "the reason is named". */
function reasonFragment(row: ErrorRow): string {
	return row.message.split(":").at(-1)?.trim() ?? row.message;
}

describe("a provider failure is resampled only when resampling could help", () => {
	it("covers both classes of failure and both arrivals", () => {
		expect(ERROR_ROWS.length).toBeGreaterThanOrEqual(14);
		expect(ERROR_ROWS.filter(row => row.resampleable).length).toBeGreaterThanOrEqual(6);
		expect(ERROR_ROWS.filter(row => !row.resampleable).length).toBeGreaterThanOrEqual(5);
		expect(new Set(ERROR_ROWS.map(row => row.name)).size).toBe(ERROR_ROWS.length);
		expect(ARRIVALS.length).toBe(2);
	});

	for (const row of ERROR_ROWS) {
		for (const arrival of ARRIVALS) {
			it(`${row.name}, ${arrival}`, async () => {
				const cell = `${row.name} / ${arrival}`;
				sim = await createSimulation({
					settings: { "retry.enabled": true },
					// Fails once, then answers. A resampleable error must reach the
					// second turn; a permanent one must never be given the chance,
					// which is why the success is scripted for every cell rather than
					// only for the ones expected to get there.
					script: turn => {
						if (turn.call === 1) {
							if (arrival === "after partial text") turn.text("partial answer. ");
							turn.fail(row.message);
							return;
						}
						turn.text(ANSWER);
						turn.finish();
					},
				});

				await sim.session.prompt("go");

				expect(describeViolations(cell, turnViolations(sim))).toEqual([]);
				if (row.resampleable) {
					expect(sim.providerCalls()).toBe(2);
					expect(lastAssistantText(sim.session)).toContain(ANSWER);
					expect(lastAssistant(sim).stopReason).toBe("stop");
					return;
				}
				// One attempt, and the operator is told what upstream said. A
				// permanent failure that spends the budget is the expensive half of
				// this contract; one that reports nothing is the useless half.
				expect(sim.providerCalls()).toBe(1);
				expect(lastAssistant(sim).stopReason).toBe("error");
				expect(lastAssistant(sim).errorMessage ?? "").toContain(reasonFragment(row));
			});
		}
	}

	for (const row of ERROR_ROWS.filter(candidate => candidate.resampleable)) {
		it(`${row.name} that never clears costs the budget and stops`, async () => {
			// The other side of the bound. A resampleable error is worth another
			// attempt, and an unbounded number of attempts is a session that never
			// reports anything, so the budget has to be spent exactly.
			sim = await createSimulation({
				settings: { "retry.enabled": true },
				script: turn => {
					turn.fail(`${row.message} (attempt ${turn.call})`);
				},
			});

			await sim.session.prompt("go");

			expect(sim.providerCalls()).toBe(RETRY_BUDGET + 1);
			expect(sim.session.isStreaming).toBe(false);
			expect(sim.session.isRetrying).toBe(false);
			expect(lastAssistant(sim).stopReason).toBe("error");
			expect(lastAssistant(sim).errorMessage ?? "").toContain(reasonFragment(row));
		});
	}

	it("keeps the partial answer a terminally failed turn had already streamed", async () => {
		// Positive control for the second axis, and the distinction the axis turns
		// on. A turn that is RETRIED discards its partial on purpose (the retry
		// replaces the answer, so keeping both would show the operator two halves
		// of one reply). A turn that runs out of budget does not get replaced, so
		// whatever streamed is all the context a follow-up has and throwing it away
		// leaves the same transcript as a turn that never started.
		sim = await createSimulation({
			settings: { "retry.enabled": true },
			script: turn => {
				turn.text(`half an answer before attempt ${turn.call} died. `);
				turn.fail("stream error: NGHTTP2_INTERNAL_ERROR");
			},
		});

		await sim.session.prompt("go");

		expect(sim.providerCalls()).toBe(RETRY_BUDGET + 1);
		const streamed = sim.session.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap(message => message.content)
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join(" ");
		expect(streamed).toContain("half an answer before attempt");
		expect(lastAssistant(sim).stopReason).toBe("error");
	});

	it("discards the partial of a turn that a retry replaced", async () => {
		// The other half of that decision, stated so a change in either direction
		// is visible: after a successful resample the transcript carries the answer
		// and not the abandoned half-reply.
		sim = await createSimulation({
			settings: { "retry.enabled": true },
			script: turn => {
				if (turn.call === 1) {
					turn.text("abandoned half-reply. ");
					turn.fail("stream error: NGHTTP2_INTERNAL_ERROR");
					return;
				}
				turn.text(ANSWER);
				turn.finish();
			},
		});

		await sim.session.prompt("go");

		expect(sim.providerCalls()).toBe(2);
		expect(lastAssistantText(sim.session)).toContain(ANSWER);
		const streamed = sim.session.messages
			.filter((message): message is AssistantMessage => message.role === "assistant")
			.flatMap(message => message.content)
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join(" ");
		expect(streamed).not.toContain("abandoned half-reply");
	});
});
