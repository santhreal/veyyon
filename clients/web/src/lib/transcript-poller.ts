/**
 * Incremental poller for one agent's host-side session file, driving the
 * AgentDrawer transcript.
 *
 * Reads from a byte cursor on an interval and appends the parsed entries. At
 * most one read is in flight; a tick that lands while one is pending is
 * skipped. A terminal host error stops the interval. A reply that resolves
 * after {@link TranscriptPoller.stop} is discarded.
 */

import type { WireSessionEntry } from "@veyyon/wire";
import type { GuestClient } from "./client";
import { decideTranscriptPoll, type TranscriptPollDecision } from "./transcript-poll";

/** Receives what the poller read. */
export interface TranscriptPollerSink {
	/** Every entry read so far, as a new array per read that added rows. */
	entries(entries: readonly WireSessionEntry[]): void;
	/** A terminal host error; polling has stopped. */
	error(message: string): void;
	/** The number of unparseable rows one read dropped. */
	dropped(count: number): void;
}

export class TranscriptPoller {
	readonly #client: Pick<GuestClient, "fetchTranscript">;
	readonly #agentId: string;
	readonly #sink: TranscriptPollerSink;
	#cursor = 0;
	#carry = "";
	#entries: readonly WireSessionEntry[] = [];
	#inFlight = false;
	#stopped = false;
	#timer: Timer | undefined;

	constructor(client: Pick<GuestClient, "fetchTranscript">, agentId: string, sink: TranscriptPollerSink) {
		this.#client = client;
		this.#agentId = agentId;
		this.#sink = sink;
	}

	/** Read once now, then every `intervalMs`. */
	start(intervalMs: number): void {
		void this.#poll();
		this.#timer = setInterval(() => void this.#poll(), intervalMs);
	}

	/** Stop the interval and discard any reply still in flight. */
	stop(): void {
		this.#stopped = true;
		this.#clearTimer();
	}

	#clearTimer(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	async #poll(): Promise<void> {
		if (this.#stopped || this.#inFlight) return;
		this.#inFlight = true;
		try {
			const reply = await this.#client.fetchTranscript(this.#agentId, this.#cursor);
			if (!this.#stopped) this.#apply(decideTranscriptPoll(reply, this.#carry));
		} finally {
			this.#inFlight = false;
		}
	}

	#apply(decision: TranscriptPollDecision): void {
		switch (decision.action) {
			case "retry":
				// Timeout or transient failure: poll again from the same cursor.
				return;
			case "stop":
				this.#clearTimer();
				this.#sink.error(decision.message);
				return;
			case "advance":
				this.#cursor = decision.newSize;
				this.#carry = decision.carry;
				if (decision.skipped.length > 0) {
					// Loud on purpose. Dropping a row silently renders a transcript
					// with a hole in it that reads as "the agent said nothing here".
					for (const skip of decision.skipped) {
						console.warn(`transcript row dropped at offset ${skip.offset}: ${skip.snippet}`);
					}
					this.#sink.dropped(decision.skipped.length);
				}
				if (decision.fresh.length > 0) {
					this.#entries = this.#entries.concat(decision.fresh);
					this.#sink.entries(this.#entries);
				}
		}
	}
}
