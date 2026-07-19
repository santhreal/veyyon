import { asRecord, finiteNumber, isRecord, trimmedString } from "@veyyon/utils";
import { scopedTimeoutSignal } from "../../utils/fetch-timeout";

// Re-export the @veyyon/utils guards/coercers so scraper modules can import
// them from this local barrel; each has exactly one definition (the owner).
export { asRecord, finiteNumber, isRecord, trimmedString };

import { ToolAbortError } from "../../tools/tool-errors";
import { convertBufferWithMarkit } from "../../utils/markit";
import { MAX_BYTES } from "./types";

export interface BinaryFetchSuccess {
	ok: true;
	buffer: Uint8Array;
	contentDisposition?: string;
}

export type BinaryFetchResult = BinaryFetchSuccess | { ok: false; error?: string };

async function readResponseWithLimit(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array(0);

	const chunks: Buffer[] = [];
	let totalBytes = 0;

	try {
		while (true) {
			if (signal?.aborted) {
				await reader.cancel();
				throw new ToolAbortError();
			}
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;

			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				await reader.cancel();
				throw new Error(`response exceeds ${maxBytes} bytes`);
			}

			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}

	return new Uint8Array(Buffer.concat(chunks, totalBytes));
}

/**
 * Fetch binary content from a URL
 */
export async function fetchBinary(url: string, timeout: number = 20, signal?: AbortSignal): Promise<BinaryFetchResult> {
	// Scoped so the deadline timer is cleared on settle instead of staying
	// armed like a bare AbortSignal.timeout; the fence spans the body read.
	const requestTimeout = scopedTimeoutSignal(timeout * 1000, signal);
	const requestSignal = requestTimeout.signal;
	try {
		const response = await fetch(url, {
			signal: requestSignal,
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; TextBot/1.0)",
			},
			redirect: "follow",
		});

		if (!response.ok) {
			return { ok: false, error: `HTTP ${response.status}` };
		}

		const contentDisposition = response.headers.get("content-disposition") || undefined;
		const contentLength = response.headers.get("content-length");
		if (contentLength) {
			const size = Number.parseInt(contentLength, 10);
			if (Number.isFinite(size) && size > MAX_BYTES) {
				return { ok: false, error: `content-length ${size} exceeds ${MAX_BYTES}` };
			}
		}
		const buffer = await readResponseWithLimit(response, MAX_BYTES, requestSignal);
		return { ok: true, buffer, contentDisposition };
	} catch (err) {
		if (signal?.aborted) throw new ToolAbortError();
		if (requestSignal.aborted) return { ok: false, error: "aborted" };
		return { ok: false, error: err instanceof Error ? err.message : "Failed to fetch binary" };
	} finally {
		requestTimeout.cancel();
	}
}

/**
 * Assemble a partial ISO 8601 calendar date from year, month, and day parts.
 *
 * Scholarly metadata reports a date at whatever precision it has: a year alone,
 * a year and month, or a full date. Missing parts are simply omitted, and each
 * present part is left-padded to two digits. The parts arrive as numbers (a
 * Crossref `date-parts` triple) or as strings (an ORCID `{value}` field), so
 * every part is stringified before padding.
 *
 * A part counts as present only when it is truthy, so `0`, `""`, `null`, and
 * `undefined` all read as absent. A day is only emitted when a month is also
 * present, because a day without a month is not a valid calendar date; this is
 * why the month and day checks nest rather than run independently. Returns
 * `null` when no year is present, since a date must have at least a year.
 */
export function partialIsoDate(
	year: number | string | null | undefined,
	month?: number | string | null,
	day?: number | string | null,
): string | null {
	if (!year) return null;
	let out = String(year);
	if (month) {
		out += `-${String(month).padStart(2, "0")}`;
		if (day) out += `-${String(day).padStart(2, "0")}`;
	}
	return out;
}

/**
 * Convert binary content to markdown using markit.
 */
export async function convertWithMarkit(
	buffer: Uint8Array,
	extension: string,
	timeout: number = 20,
	signal?: AbortSignal,
): Promise<{ content: string; ok: boolean; error?: string }> {
	const conversionTimeout = scopedTimeoutSignal(timeout * 1000, signal);
	try {
		return await convertBufferWithMarkit(buffer, extension, conversionTimeout.signal);
	} finally {
		conversionTimeout.cancel();
	}
}
