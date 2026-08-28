function randu32() {
	return crypto.getRandomValues(new Uint32Array(1))[0];
}

const EPOCH = 1420070400000;
const MAX_SEQ = 0x3fffff;

type Snowflake = string & { readonly __brand: unique symbol };

namespace Snowflake {
	export const PATTERN = /^[0-9a-f]{16}$/;

	export const EPOCH_TIMESTAMP = EPOCH;

	export const MAX_SEQUENCE = MAX_SEQ;

	export function formatParts(dt: number, seq: number): Snowflake {
		return ((BigInt(dt) << 22n) | BigInt(seq)).toString(16).padStart(16, "0") as Snowflake;
	}

	export class Source {
		#seq = 0;
		constructor(sequence: number = randu32() & MAX_SEQ) {
			this.#seq = sequence & MAX_SEQ;
		}

		get sequence() {
			return this.#seq & MAX_SEQ;
		}
		set sequence(v: number) {
			this.#seq = v & MAX_SEQ;
		}
		reset() {
			this.#seq = 0;
		}

		generate(timestamp: number): Snowflake {
			const seq = (this.#seq + 1) & MAX_SEQ;
			const dt = timestamp - EPOCH;
			this.#seq = seq;
			return formatParts(dt, seq);
		}
	}

	let defaultSource: Source | undefined;
	export function next(timestamp = Date.now()): Snowflake {
		defaultSource ??= new Source();
		return defaultSource.generate(timestamp);
	}

	export function valid(value: string): value is Snowflake {
		return value.length === 16 && PATTERN.test(value);
	}

	export function lowerbound(timelike: Date | number | Snowflake): Snowflake {
		switch (typeof timelike) {
			case "object": // Date
				return formatParts(timelike.getTime() - EPOCH, 0);
			case "number":
				return formatParts(timelike - EPOCH, 0);
			case "string": // Snowflake hex string
				return timelike;
		}
	}
	export function upperbound(timelike: Date | number | Snowflake): Snowflake {
		switch (typeof timelike) {
			case "object": // Date
				return formatParts(timelike.getTime() - EPOCH, MAX_SEQ);
			case "number":
				return formatParts(timelike - EPOCH, MAX_SEQ);
			case "string": // Snowflake hex string
				return timelike;
		}
	}

	export function getSequence(value: Snowflake) {
		return Number.parseInt(value.substring(8, 16), 16) & MAX_SEQ;
	}
	export function getTimestamp(value: Snowflake) {
		const hi = Number.parseInt(value.substring(0, 8), 16);
		const lo = Number.parseInt(value.substring(8, 16), 16);
		return hi * 1024 + (lo >>> 22) + EPOCH;
	}
	export function getDate(value: Snowflake) {
		return new Date(getTimestamp(value));
	}
}

export { Snowflake };
