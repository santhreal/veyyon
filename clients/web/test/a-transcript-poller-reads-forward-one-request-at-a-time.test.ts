/**
 * The AgentDrawer's transcript poller reads one agent's session file forward
 * from a byte cursor. Defends: the cursor advances only on rows, entries
 * accumulate across reads, a tick never stacks a second request on a pending
 * one, a terminal host error ends polling, a reply landing after `stop()` is
 * discarded, and dropped rows are counted.
 *
 * Gap: reply parsing is `decideTranscriptPoll`'s contract and is covered in
 * transcript-polling.test.ts; this suite does not re-derive it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { WireSessionEntry } from "@veyyon/wire";
import type { TranscriptResult } from "../src/lib/client";
import { TranscriptPoller } from "../src/lib/transcript-poller";

const INTERVAL_MS = 1_000;

interface FetchCall {
	agentId: string;
	cursor: number;
	reply: PromiseWithResolvers<TranscriptResult | null>;
}

class ScriptedClient {
	readonly calls: FetchCall[] = [];

	fetchTranscript(agentId: string, cursor: number): Promise<TranscriptResult | null> {
		const reply = Promise.withResolvers<TranscriptResult | null>();
		this.calls.push({ agentId, cursor, reply });
		return reply.promise;
	}
}

interface Received {
	entries: (readonly WireSessionEntry[])[];
	errors: string[];
	dropped: number[];
}

function row(id: string): string {
	return `${JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-06-12T00:00:01Z", message: { role: "user", content: id, timestamp: 1 } })}\n`;
}

function startPoller(): { client: ScriptedClient; poller: TranscriptPoller; received: Received } {
	const client = new ScriptedClient();
	const received: Received = { entries: [], errors: [], dropped: [] };
	const poller = new TranscriptPoller(client, "agent-7", {
		entries: entries => received.entries.push(entries),
		error: message => received.errors.push(message),
		dropped: count => received.dropped.push(count),
	});
	poller.start(INTERVAL_MS);
	return { client, poller, received };
}

/** Resolves call `index` and lets the poller's continuation run. */
async function answer(client: ScriptedClient, index: number, reply: TranscriptResult | null): Promise<void> {
	const call = client.calls[index];
	if (!call) throw new Error(`no fetch #${index}; ${client.calls.length} issued`);
	call.reply.resolve(reply);
	await call.reply.promise;
	await Promise.resolve();
}

describe("TranscriptPoller", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("reads at once from offset 0, then from the size each read returned, accumulating entries", async () => {
		const { client, poller, received } = startPoller();
		const first = row("a");
		const second = row("b");
		expect(client.calls.map(call => [call.agentId, call.cursor])).toEqual([["agent-7", 0]]);

		await answer(client, 0, { kind: "rows", text: first, newSize: first.length });
		vi.advanceTimersByTime(INTERVAL_MS);
		await answer(client, 1, { kind: "rows", text: second, newSize: first.length + second.length });
		poller.stop();

		expect(client.calls.map(call => call.cursor)).toEqual([0, first.length]);
		expect(received.entries.map(entries => entries.map(entry => entry.id))).toEqual([["a"], ["a", "b"]]);
		expect(received.errors).toEqual([]);
	});

	it("completes a row split across two reads", async () => {
		const { client, poller, received } = startPoller();
		const whole = row("split");
		const cut = 20;
		await answer(client, 0, { kind: "rows", text: whole.slice(0, cut), newSize: cut });
		vi.advanceTimersByTime(INTERVAL_MS);
		await answer(client, 1, { kind: "rows", text: whole.slice(cut), newSize: whole.length });
		poller.stop();

		expect(client.calls.map(call => call.cursor)).toEqual([0, cut]);
		expect(received.entries.map(entries => entries.map(entry => entry.id))).toEqual([["split"]]);
		expect(received.dropped).toEqual([]);
	});

	it("keeps the cursor and reports nothing when a read times out", async () => {
		const { client, poller, received } = startPoller();
		const first = row("a");
		await answer(client, 0, { kind: "rows", text: first, newSize: first.length });
		vi.advanceTimersByTime(INTERVAL_MS);
		await answer(client, 1, null);
		vi.advanceTimersByTime(INTERVAL_MS);
		poller.stop();

		expect(client.calls.map(call => call.cursor)).toEqual([0, first.length, first.length]);
		expect(received.entries).toHaveLength(1);
		expect(received.errors).toEqual([]);
	});

	it("issues no second request while one is pending", async () => {
		const { client, poller } = startPoller();
		vi.advanceTimersByTime(INTERVAL_MS * 3);
		expect(client.calls).toHaveLength(1);

		await answer(client, 0, null);
		vi.advanceTimersByTime(INTERVAL_MS);
		poller.stop();
		expect(client.calls).toHaveLength(2);
	});

	it("stops polling on a terminal host error and keeps the rows already read", async () => {
		const { client, poller, received } = startPoller();
		const first = row("a");
		await answer(client, 0, { kind: "rows", text: first, newSize: first.length });
		vi.advanceTimersByTime(INTERVAL_MS);
		await answer(client, 1, { kind: "error", message: "no transcript available" });
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(INTERVAL_MS * 5);
		poller.stop();

		expect(client.calls).toHaveLength(2);
		expect(received.errors).toEqual(["no transcript available"]);
		expect(received.entries.map(entries => entries.map(entry => entry.id))).toEqual([["a"]]);
	});

	it("discards a reply that lands after stop and issues no further request", async () => {
		const { client, poller, received } = startPoller();
		poller.stop();
		expect(vi.getTimerCount()).toBe(0);
		await answer(client, 0, { kind: "rows", text: row("late"), newSize: 99 });
		vi.advanceTimersByTime(INTERVAL_MS * 5);

		expect(client.calls).toHaveLength(1);
		expect(received).toEqual({ entries: [], errors: [], dropped: [] });
	});

	it("counts unparseable rows and still delivers the valid ones", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { client, poller, received } = startPoller();
		const text = `${row("a")}{broken\n${row("b")}not json either\n`;
		await answer(client, 0, { kind: "rows", text, newSize: text.length });
		poller.stop();

		expect(received.dropped).toEqual([2]);
		expect(received.entries.map(entries => entries.map(entry => entry.id))).toEqual([["a", "b"]]);
	});

	it("reports no entries for a read that added none", async () => {
		const { client, poller, received } = startPoller();
		const header = `${JSON.stringify({ type: "session", id: "s" })}\n`;
		await answer(client, 0, { kind: "rows", text: header, newSize: header.length });
		poller.stop();

		expect(received).toEqual({ entries: [], errors: [], dropped: [] });
	});
});
