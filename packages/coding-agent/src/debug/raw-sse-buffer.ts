import type { Model, ProviderResponseMetadata, RawSseEvent } from "@veyyon/ai";
import type { RawSseDebugRecord, RawSseDebugSnapshot } from "./raw-sse-buffer-helpers";
import {
	formatRawSseResponseComment,
	MAX_RAW_SSE_CHARS,
	MAX_RAW_SSE_EVENTS,
	metadataTransport,
	rawRecordText,
	trimRawLines,
} from "./raw-sse-buffer-helpers";

export { formatRawSseIsoTime, rawSseRecordLines } from "./raw-sse-buffer-helpers";
export type { RawSseDebugRecord };
export { formatRawSseResponseComment };

export class RawSseDebugBuffer {
	#records: RawSseDebugRecord[] = [];
	#recordChars: number[] = [];
	#head = 0;
	#totalChars = 0;
	#droppedRecords = 0;
	#droppedChars = 0;
	#totalEvents = 0;
	#lastUpdatedAt: number | undefined;
	#nextSequence = 1;
	#listeners = new Set<() => void>();
	#emitScheduled = false;

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	recordResponse(response: ProviderResponseMetadata, model?: Model): void {
		const record: RawSseDebugRecord = {
			kind: "response",
			sequence: this.#nextSequence++,
			timestamp: Date.now(),
			provider: model?.provider,
			model: model?.id,
			api: model?.api,
			status: response.status,
			requestId: response.requestId,
			transport: metadataTransport(response),
		};
		this.#append(record, formatRawSseResponseComment(record).length + 1);
	}

	recordEvent(event: RawSseEvent, model?: Model): void {
		const trimmed = trimRawLines(event.raw);
		this.#totalEvents += 1;
		this.#append(
			{
				kind: "event",
				sequence: this.#nextSequence++,
				timestamp: Date.now(),
				provider: model?.provider,
				model: model?.id,
				api: model?.api,
				event: event.event,
				raw: trimmed.raw,
				truncated: trimmed.truncated,
				originalChars: trimmed.originalChars,
			},
			trimmed.chars,
		);
	}

	snapshot(): RawSseDebugSnapshot {
		return {
			records: this.#records.slice(this.#head),
			droppedRecords: this.#droppedRecords,
			droppedChars: this.#droppedChars,
			totalEvents: this.#totalEvents,
			lastUpdatedAt: this.#lastUpdatedAt,
		};
	}

	toRawText(): string {
		const live = this.#head === 0 ? this.#records : this.#records.slice(this.#head);
		const body = live.map(rawRecordText).join("\n");
		if (this.#droppedRecords === 0) return body;
		const dropped = `: veyyon-debug-dropped records=${this.#droppedRecords} chars=${this.#droppedChars}\n\n`;
		return body.length > 0 ? `${dropped}${body}` : dropped;
	}

	#append(record: RawSseDebugRecord, chars: number): void {
		this.#records.push(record);
		this.#recordChars.push(chars);
		this.#totalChars += chars;
		this.#lastUpdatedAt = record.timestamp;
		this.#enforceLimits();
		this.#emit();
	}

	#enforceLimits(): void {
		while (this.#records.length - this.#head > MAX_RAW_SSE_EVENTS || this.#totalChars > MAX_RAW_SSE_CHARS) {
			if (this.#records.length - this.#head === 0) break;
			const chars = this.#recordChars[this.#head] ?? 0;
			this.#head += 1;
			this.#totalChars = Math.max(0, this.#totalChars - chars);
			this.#droppedRecords += 1;
			this.#droppedChars += chars;
		}
		const liveCount = this.#records.length - this.#head;
		if (this.#head >= MAX_RAW_SSE_EVENTS || this.#head > liveCount) {
			this.#records = this.#records.slice(this.#head);
			this.#recordChars = this.#recordChars.slice(this.#head);
			this.#head = 0;
		}
	}

	#emit(): void {
		const count = this.#listeners.size;
		if (count === 0) return;
		if (count === 1) {
			this.#fanOut();
			return;
		}
		if (this.#emitScheduled) return;
		this.#emitScheduled = true;
		queueMicrotask(() => {
			this.#emitScheduled = false;
			this.#fanOut();
		});
	}

	#fanOut(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch {}
		}
	}
}

const globalFallbackBuffer = new RawSseDebugBuffer();
const kRawSseDebugBuffer = Symbol("debug.rawSseBuffer");
type OwnerWithBuffer = object & { rawSseDebugBuffer?: unknown; [kRawSseDebugBuffer]?: RawSseDebugBuffer };

export function resolveRawSseDebugBuffer(owner?: object): RawSseDebugBuffer {
	if (!owner) return globalFallbackBuffer;

	const tagged = owner as OwnerWithBuffer;
	const declared = tagged.rawSseDebugBuffer;
	if (declared instanceof RawSseDebugBuffer) return declared;

	const existing = tagged[kRawSseDebugBuffer];
	if (existing) return existing;

	const buffer = new RawSseDebugBuffer();
	try {
		tagged[kRawSseDebugBuffer] = buffer;
	} catch {}
	return buffer;
}
