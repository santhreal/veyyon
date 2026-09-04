/**
 * Incremental JSONL transcript reader for still-running trials that parses live
 * spend and token counts without loading whole transcripts into memory.
 */
import { Buffer } from "node:buffer";
import * as fs from "node:fs";

/** Running usage totals for one live trial's transcript, plus the parse cursor. */
export interface CostProbe {
	/** Bytes of the transcript already consumed. */
	offset: number;
	/** Trailing partial line carried to the next read (bytes, so multi-byte chars survive chunking). */
	remainder: Buffer;
	/** True while discarding an oversized line (resync at the next newline). */
	discarding: boolean;
	/** Spend summed over the usage events that carried a price, or null while none did. */
	costUsd: number | null;
	/** Input tokens summed over the usage events that carried a count, or null while none did. */
	tokIn: number | null;
	/** Output tokens summed the same way, or null while none was counted. */
	tokOut: number | null;
	/** Cache-read tokens summed the same way, or null while none was counted. */
	tokCache: number | null;
}

/** Incremental parse state per live transcript path. Entries are dropped once the trial finishes. */
const costProbes = new Map<string, CostProbe>();

/** First sight of an already-huge transcript: parse only its tail (undercounts cost, never OOMs). */
export const COST_PROBE_FIRST_SCAN_BYTES = 16 * 1024 * 1024;
/** A single line longer than this is bloat/corruption, never a usage event: skip it. */
export const COST_PROBE_MAX_LINE_BYTES = 4 * 1024 * 1024;
export const COST_PROBE_CHUNK_BYTES = 1024 * 1024;

function finite(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Add a measured delta to a running total, leaving a total nothing measured absent. */
function add(total: number | null, delta: number | null): number | null {
	if (delta === null) return total;
	return total === null ? delta : total + delta;
}

/** Accumulate assistant `message_end` usage from one complete transcript line. */
export function probeLine(line: string, probe: CostProbe): void {
	const trimmed = line.trim();
	if (!trimmed) return;
	try {
		const event = JSON.parse(trimmed);
		if (event?.type !== "message_end") return;
		const message = event.message;
		if (!message || typeof message !== "object" || message.role !== "assistant") return;
		const usage = message.usage;
		if (!usage || typeof usage !== "object") return;
		const input = finite(usage.input);
		const cacheRead = finite(usage.cacheRead);
		if (input !== null || cacheRead !== null) probe.tokIn = add(probe.tokIn, (input ?? 0) + (cacheRead ?? 0));
		probe.tokOut = add(probe.tokOut, finite(usage.output));
		probe.tokCache = add(probe.tokCache, cacheRead);
		const cost = usage.cost;
		if (cost && typeof cost === "object") probe.costUsd = add(probe.costUsd, finite(cost.total));
	} catch {
		/* Ignore malformed lines from incomplete writes */
	}
}

/**
 * Realtime usage for a still-running trial, read incrementally from its
 * agent transcript JSONL. Only bytes appended since the previous call are read
 * and parsed — both this runner's render loop and the manager's 2s sync tick
 * call this for every live trial, and a full-file reread used to block the
 * event loop for seconds (and OOM outright on runaway multi-GB transcripts).
 */
export function probeTrialCost(ompLogPath: string): CostProbe | null {
	let size: number;
	try {
		size = fs.statSync(ompLogPath).size;
	} catch {
		return costProbes.get(ompLogPath) ?? null;
	}
	let probe = costProbes.get(ompLogPath);
	if (!probe || size < probe.offset) {
		// New (or truncated/rotated) transcript. Skip a pre-existing giant head.
		probe = {
			offset: Math.max(0, size - COST_PROBE_FIRST_SCAN_BYTES),
			remainder: Buffer.alloc(0),
			discarding: size > COST_PROBE_FIRST_SCAN_BYTES, // resync to the next full line
			costUsd: null,
			tokIn: null,
			tokOut: null,
			tokCache: null,
		};
		costProbes.set(ompLogPath, probe);
	}
	let fd: number;
	try {
		fd = fs.openSync(ompLogPath, "r");
	} catch {
		return probe;
	}
	try {
		const chunk = Buffer.allocUnsafe(COST_PROBE_CHUNK_BYTES);
		for (;;) {
			const read = fs.readSync(fd, chunk, 0, chunk.length, probe.offset);
			if (read <= 0) break;
			probe.offset += read;
			const data = Buffer.concat([probe.remainder, chunk.subarray(0, read)]);
			let start = 0;
			for (;;) {
				const nl = data.indexOf(0x0a, start);
				if (nl === -1) break;
				if (probe.discarding) probe.discarding = false;
				else probeLine(data.subarray(start, nl).toString("utf8"), probe);
				start = nl + 1;
			}
			probe.remainder = data.subarray(start);
			if (probe.remainder.length > COST_PROBE_MAX_LINE_BYTES) {
				probe.remainder = Buffer.alloc(0);
				probe.discarding = true;
			}
		}
	} catch {
		/* keep whatever was accumulated; retry next tick */
	} finally {
		fs.closeSync(fd);
	}
	return probe;
}

/** Drop the cached incremental probe state when a trial finishes. */
export function dropCostProbe(ompLogPath: string): void {
	costProbes.delete(ompLogPath);
}

/** Reset all cached probe states (primarily for test isolation). */
export function resetCostProbes(): void {
	costProbes.clear();
}
