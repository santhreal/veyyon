import type { Subprocess } from "bun";

export type InMask = "pipe" | "ignore" | Buffer | Uint8Array | null;

export type PipedSubprocess<In extends InMask = InMask> = Subprocess<In, "pipe", "pipe">;

export abstract class Exception extends Error {
	constructor(
		message: string,
		public readonly exitCode: number,
		public readonly stderr: string,
	) {
		super(message);
		this.name = this.constructor.name;
	}
	abstract readonly aborted: boolean;
}
