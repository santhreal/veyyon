import type { Socket } from "node:net";
import { logger } from "@veyyon/utils";

/** Maximum allowed frame size: 32 MiB (mirrored by Rust crates/veyyon-desktop/src/framing.rs). */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/**
 * Line-delimited JSON frame decoder for socket streams.
 *
 * Accumulates raw byte chunks, splits on `\n` (byte 0x0A), skips empty keep-alive
 * lines, rejects frames larger than 32 MiB, and parses UTF-8 JSON payloads. Multi-byte
 * UTF-8 sequences split across chunk boundaries are preserved safely because buffer
 * accumulation happens at the raw byte level before slicing.
 */
export class FrameDecoder {
	#socket: Socket;
	#onFrame: (frame: unknown) => void;
	#onError?: (error: Error) => void;
	#buffer = Buffer.alloc(0);
	#destroyed = false;

	constructor(socket: Socket, onFrame: (frame: unknown) => void, onError?: (error: Error) => void) {
		this.#socket = socket;
		this.#onFrame = onFrame;
		this.#onError = onError;

		this.#socket.on("data", this.#handleData);
	}

	#handleData = (chunk: Buffer): void => {
		if (this.#destroyed) {
			return;
		}

		const data = Buffer.from(chunk);
		this.#buffer = this.#buffer.length === 0 ? data : Buffer.concat([this.#buffer, data]);
		while (this.#buffer.length > 0 && !this.#destroyed) {
			const newlineIndex = this.#buffer.indexOf(0x0a);

			if (newlineIndex === -1) {
				if (this.#buffer.length > MAX_FRAME_BYTES) {
					logger.error("GUI host frame exceeded maximum allowed size without newline", {
						bytes: this.#buffer.length,
						maxBytes: MAX_FRAME_BYTES,
					});
					this.#fail(new Error(`Frame exceeded maximum allowed size of ${MAX_FRAME_BYTES} bytes`));
				}
				break;
			}

			if (newlineIndex > MAX_FRAME_BYTES) {
				logger.error("GUI host frame exceeded maximum allowed size", {
					bytes: newlineIndex,
					maxBytes: MAX_FRAME_BYTES,
				});
				this.#fail(new Error(`Frame exceeded maximum allowed size of ${MAX_FRAME_BYTES} bytes`));
				break;
			}

			const lineBuffer = this.#buffer.subarray(0, newlineIndex);
			this.#buffer = this.#buffer.subarray(newlineIndex + 1);

			const line = lineBuffer.toString("utf8");
			if (line.trim().length === 0) {
				// Empty line keep-alive
				continue;
			}

			try {
				const parsed: unknown = JSON.parse(line);
				this.#onFrame(parsed);
			} catch (error) {
				logger.error("GUI host received malformed JSON frame", {
					error: error instanceof Error ? error.message : String(error),
					preview: line.slice(0, 120),
				});
				this.#fail(new Error(`Malformed JSON frame: ${error instanceof Error ? error.message : String(error)}`));
				break;
			}
		}
	};

	#fail(error: Error): void {
		if (this.#destroyed) {
			return;
		}
		this.#destroyed = true;
		this.#socket.off("data", this.#handleData);
		this.#socket.destroy(error);
		this.#onError?.(error);
	}

	detach(): void {
		this.#destroyed = true;
		this.#socket.off("data", this.#handleData);
		this.#buffer = Buffer.alloc(0);
	}
}

/**
 * Serialize a JSON value as a single-line frame terminated by newline.
 */
export function writeFrame<T>(socket: Socket, value: T): boolean {
	const payload = `${JSON.stringify(value)}\n`;
	return socket.write(payload, "utf8");
}
