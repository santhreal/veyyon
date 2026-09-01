import type { ProviderResponseMetadata } from "@veyyon/ai";

export const MAX_RAW_SSE_EVENTS = 1_000;
export const MAX_RAW_SSE_CHARS = 512_000;
export const MAX_RAW_SSE_EVENT_CHARS = 64_000;

export type RawSseDebugRecord =
	| {
			kind: "response";
			sequence: number;
			timestamp: number;
			provider?: string;
			model?: string;
			api?: string;
			status: number;
			requestId?: string | null;
			transport?: string;
	  }
	| {
			kind: "event";
			sequence: number;
			timestamp: number;
			provider?: string;
			model?: string;
			api?: string;
			event: string | null;
			raw: string[];
			truncated: boolean;
			originalChars: number;
	  };

export interface RawSseDebugSnapshot {
	records: readonly RawSseDebugRecord[];
	droppedRecords: number;
	droppedChars: number;
	totalEvents: number;
	lastUpdatedAt?: number;
}

export type TrimResult = { raw: string[]; truncated: boolean; originalChars: number; chars: number };

export function trimRawLines(raw: string[]): TrimResult {
	let originalChars = 0;
	for (let i = 0; i < raw.length; i++) originalChars += raw[i].length + 1;

	if (originalChars <= MAX_RAW_SSE_EVENT_CHARS) {
		return { raw, truncated: false, originalChars, chars: originalChars + 1 };
	}

	const trimmed: string[] = [];
	let remaining = MAX_RAW_SSE_EVENT_CHARS;
	let chars = 1; // matches reduce(.., init = 1)
	for (const line of raw) {
		if (remaining <= 0) break;
		if (line.length + 1 <= remaining) {
			trimmed.push(line);
			chars += line.length + 1;
			remaining -= line.length + 1;
			continue;
		}
		const slice = line.slice(0, Math.max(0, remaining));
		trimmed.push(slice);
		chars += slice.length + 1;
		remaining = 0;
	}
	const tail = `: veyyon-debug-truncated originalChars=${originalChars}`;
	trimmed.push(tail);
	chars += tail.length + 1;
	return { raw: trimmed, truncated: true, originalChars, chars };
}

export function formatRawSseIsoTime(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

export function formatRawSseResponseComment(record: Extract<RawSseDebugRecord, { kind: "response" }>): string {
	const fields = [
		"veyyon-response",
		`ts=${formatRawSseIsoTime(record.timestamp)}`,
		`status=${record.status}`,
		record.provider ? `provider=${record.provider}` : undefined,
		record.model ? `model=${record.model}` : undefined,
		record.api ? `api=${record.api}` : undefined,
		record.requestId ? `requestId=${record.requestId}` : undefined,
		record.transport ? `transport=${record.transport}` : undefined,
	].filter((field): field is string => field !== undefined);
	return `: ${fields.join(" ")}`;
}

export function rawSseRecordLines(record: RawSseDebugRecord): string[] {
	if (record.kind === "response") return [formatRawSseResponseComment(record)];
	return record.raw;
}

export function rawRecordText(record: RawSseDebugRecord): string {
	return `${rawSseRecordLines(record).join("\n")}\n`;
}

export function metadataTransport(response: ProviderResponseMetadata): string | undefined {
	const value = response.metadata?.lastTransport;
	return typeof value === "string" ? value : undefined;
}
