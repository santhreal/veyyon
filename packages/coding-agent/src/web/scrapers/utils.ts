import { asRecord, finiteNumber, isRecord, trimmedString } from "@veyyon/utils/type-guards";
import { scopedTimeoutSignal } from "../../utils/fetch-timeout";

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

export async function fetchBinary(url: string, timeout: number = 20, signal?: AbortSignal): Promise<BinaryFetchResult> {
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
