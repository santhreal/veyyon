import { clampLow } from "@veyyon/utils";
import type { EndpointerConfig, EndpointerEvent } from "./endpointer-helpers";
import { DEFAULT_ENDPOINTER_CONFIG } from "./endpointer-helpers";

export type { EndpointerEvent };
export { DEFAULT_ENDPOINTER_CONFIG };

class FloatBuffer {
	#data = new Float32Array(0);
	#len = 0;

	get length(): number {
		return this.#len;
	}

	push(samples: Float32Array): void {
		const needed = this.#len + samples.length;
		if (needed > this.#data.length) {
			const next = new Float32Array(Math.max(this.#data.length * 2, needed, 1 << 14));
			next.set(this.#data.subarray(0, this.#len));
			this.#data = next;
		}
		this.#data.set(samples, this.#len);
		this.#len += samples.length;
	}

	take(end = this.#len): Float32Array {
		return this.#data.slice(0, clampLow(end, 0, this.#len));
	}

	reset(): void {
		this.#len = 0;
	}
}

function rms(frame: Float32Array): number {
	let sum = 0;
	for (let i = 0; i < frame.length; i += 1) sum += frame[i]! * frame[i]!;
	return Math.sqrt(sum / Math.max(1, frame.length));
}

export class StreamEndpointer {
	readonly #cfg: EndpointerConfig;
	readonly #frameSamples: number;
	readonly #preRollSamples: number;

	#leftover = new Float32Array(0);
	#inSpeech = false;
	#noiseFloor: number;
	#silenceMs = 0;
	#segmentMs = 0;
	#msSincePartial = 0;
	#partialDirty = false;

	readonly #segment = new FloatBuffer();
	readonly #preRoll = new FloatBuffer();

	constructor(config: Partial<EndpointerConfig> = {}) {
		this.#cfg = { ...DEFAULT_ENDPOINTER_CONFIG, ...config };
		this.#frameSamples = Math.max(1, Math.round((this.#cfg.sampleRate * this.#cfg.frameMs) / 1000));
		this.#preRollSamples = Math.max(0, Math.round((this.#cfg.sampleRate * this.#cfg.preRollMs) / 1000));
		this.#noiseFloor = this.#cfg.minThreshold;
	}

	push(samples: Float32Array): EndpointerEvent[] {
		const events: EndpointerEvent[] = [];
		let buf: Float32Array;
		if (this.#leftover.length === 0) {
			buf = samples;
		} else {
			buf = new Float32Array(this.#leftover.length + samples.length);
			buf.set(this.#leftover, 0);
			buf.set(samples, this.#leftover.length);
		}
		let offset = 0;
		for (; offset + this.#frameSamples <= buf.length; offset += this.#frameSamples) {
			this.#processFrame(buf.subarray(offset, offset + this.#frameSamples), events);
		}
		this.#leftover = buf.slice(offset);
		return events;
	}

	flush(): EndpointerEvent[] {
		const events: EndpointerEvent[] = [];
		if (this.#inSpeech && this.#leftover.length > 0) {
			this.#segment.push(this.#leftover);
			this.#segmentMs += (this.#leftover.length / this.#cfg.sampleRate) * 1000;
		}
		this.#leftover = new Float32Array(0);
		if (this.#inSpeech) {
			const speechMs = this.#segmentMs - this.#silenceMs;
			if (speechMs >= this.#cfg.minSpeechMs) {
				events.push({ kind: "segment", audio: this.#segment.take(this.#endpointKeep()) });
			}
		}
		this.#reset();
		return events;
	}

	#processFrame(frame: Float32Array, events: EndpointerEvent[]): void {
		const energy = rms(frame);
		const threshold = Math.max(this.#cfg.minThreshold, this.#noiseFloor * this.#cfg.energyRatio);
		const voiced = energy > threshold;
		if (!voiced) {
			this.#noiseFloor = this.#noiseFloor * (1 - this.#cfg.floorAttack) + energy * this.#cfg.floorAttack;
		}

		if (!this.#inSpeech) {
			this.#preRoll.push(frame);
			if (this.#preRoll.length > this.#preRollSamples) {
				const tail = this.#preRoll.take().slice(this.#preRoll.length - this.#preRollSamples);
				this.#preRoll.reset();
				this.#preRoll.push(tail);
			}
			if (voiced) this.#beginSegment(frame);
			return;
		}

		this.#segment.push(frame);
		this.#segmentMs += this.#cfg.frameMs;
		this.#msSincePartial += this.#cfg.frameMs;
		if (voiced) {
			this.#silenceMs = 0;
			this.#partialDirty = true;
		} else {
			this.#silenceMs += this.#cfg.frameMs;
		}

		if (this.#silenceMs >= this.#cfg.endSilenceMs) {
			this.#finalizeSegment(events);
			return;
		}
		if (this.#segmentMs >= this.#cfg.maxSegmentMs) {
			events.push({ kind: "segment", audio: this.#segment.take() });
			this.#segment.reset();
			this.#segmentMs = 0;
			this.#silenceMs = 0;
			this.#msSincePartial = 0;
			this.#partialDirty = false;
			return;
		}
		if (this.#partialDirty && this.#msSincePartial >= this.#cfg.partialIntervalMs) {
			events.push({ kind: "partial", audio: this.#segment.take() });
			this.#msSincePartial = 0;
			this.#partialDirty = false;
		}
	}

	#beginSegment(onsetFrame: Float32Array): void {
		this.#inSpeech = true;
		this.#segment.reset();
		const preRoll = this.#preRoll.take();
		if (preRoll.length > 0) this.#segment.push(preRoll);
		this.#segment.push(onsetFrame);
		this.#preRoll.reset();
		this.#silenceMs = 0;
		this.#segmentMs = (this.#segment.length / this.#cfg.sampleRate) * 1000;
		this.#msSincePartial = 0;
		this.#partialDirty = true;
	}

	#finalizeSegment(events: EndpointerEvent[]): void {
		const speechMs = this.#segmentMs - this.#silenceMs;
		if (speechMs >= this.#cfg.minSpeechMs) {
			events.push({ kind: "segment", audio: this.#segment.take(this.#endpointKeep()) });
		}
		this.#inSpeech = false;
		this.#segment.reset();
		this.#silenceMs = 0;
		this.#segmentMs = 0;
		this.#msSincePartial = 0;
		this.#partialDirty = false;
	}

	#endpointKeep(): number {
		const tailMs = Math.min(this.#silenceMs, 120);
		const dropMs = Math.max(0, this.#silenceMs - tailMs);
		const drop = Math.round((this.#cfg.sampleRate * dropMs) / 1000);
		return Math.max(0, this.#segment.length - drop);
	}

	#reset(): void {
		this.#inSpeech = false;
		this.#segment.reset();
		this.#preRoll.reset();
		this.#silenceMs = 0;
		this.#segmentMs = 0;
		this.#msSincePartial = 0;
		this.#partialDirty = false;
		this.#noiseFloor = this.#cfg.minThreshold;
	}
}
