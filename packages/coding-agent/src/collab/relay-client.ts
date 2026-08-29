import { exponentialBackoffDelay, logger } from "@veyyon/utils";
import { RELAY_FATAL_CLOSE_REASONS, RELAY_MAX_PENDING_SENDS } from "@veyyon/wire/relay";
import { open, seal } from "./crypto";
import type { CollabFrame, RelayControlMessage } from "./protocol";
import { packEnvelope, unpackEnvelope } from "./protocol";
import type { CollabSocketOptions } from "./relay-client-helpers";
import {
	WS_BACKPRESSURE_DRAIN_RETRY_MS,
	WS_BACKPRESSURE_DRAIN_THRESHOLD,
	WS_BACKPRESSURE_THRESHOLD,
} from "./relay-client-helpers";

export class CollabSocket {
	onOpen?: () => void;
	onFrame?: (frame: CollabFrame, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	onClose?: (reason: string, willReconnect: boolean) => void;

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: NodeJS.Timeout | undefined;
	#backpressureDrainTimer: NodeJS.Timeout | undefined;
	#attempt = 0;
	#closed = false;
	#sendChain: Promise<void> = Promise.resolve();
	#recvChain: Promise<void> = Promise.resolve();
	#pendingSends: Uint8Array[] = [];

	constructor(opts: CollabSocketOptions) {
		this.#opts = opts;
	}

	get isOpen(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#attempt = 0;
		this.#openSocket();
	}

	send(frame: CollabFrame, targetPeer = 0): void {
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (this.#closed) {
					logger.debug("collab: dropping frame, socket closed", { t: frame.t });
					return;
				}
				const openWs = this.#ws;
				if (openWs && openWs.readyState === WebSocket.OPEN) this.#drainPendingSends(openWs);
				const sealed = await seal(this.#opts.key, frame);
				const envelope = packEnvelope(targetPeer, sealed);
				const ws = this.#ws;
				if (ws && ws.readyState === WebSocket.OPEN) {
					if (this.#pendingSends.length > 0) {
						this.#enqueuePendingSend(envelope, frame.t);
						if (ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD) {
							this.#drainPendingSends(ws);
						} else {
							this.#scheduleBackpressureDrain(ws);
						}
						return;
					}
					if (ws.bufferedAmount >= WS_BACKPRESSURE_THRESHOLD) {
						this.#enqueuePendingSend(envelope, frame.t);
						this.#scheduleBackpressureDrain(ws);
						return;
					}
					ws.send(envelope);
					return;
				}
				this.#enqueuePendingSend(envelope, frame.t);
			})
			.catch((err: unknown) => {
				logger.debug("collab: send failed", { error: String(err) });
			});
	}

	#enqueuePendingSend(envelope: Uint8Array, frameType: CollabFrame["t"]): void {
		if (this.#pendingSends.length >= RELAY_MAX_PENDING_SENDS) {
			logger.debug("collab: dropping frame, reconnect buffer full", { t: frameType });
			return;
		}
		this.#pendingSends.push(envelope);
	}

	#drainPendingSends(ws: WebSocket): void {
		while (
			this.#pendingSends.length > 0 &&
			ws.readyState === WebSocket.OPEN &&
			ws.bufferedAmount < WS_BACKPRESSURE_DRAIN_THRESHOLD
		) {
			const envelope = this.#pendingSends.shift();
			if (!envelope) return;
			ws.send(envelope);
		}
	}

	#scheduleBackpressureDrain(ws: WebSocket): void {
		if (this.#backpressureDrainTimer !== undefined) return;
		this.#backpressureDrainTimer = setTimeout(() => {
			this.#backpressureDrainTimer = undefined;
			this.#sendChain = this.#sendChain
				.then(async () => {
					if (this.#closed || this.#ws !== ws || ws.readyState !== WebSocket.OPEN) return;
					this.#drainPendingSends(ws);
					if (this.#pendingSends.length > 0) this.#scheduleBackpressureDrain(ws);
				})
				.catch((err: unknown) => {
					logger.debug("collab: backpressure drain failed", { error: String(err) });
				});
		}, WS_BACKPRESSURE_DRAIN_RETRY_MS);
	}

	#clearBackpressureDrain(): void {
		if (this.#backpressureDrainTimer !== undefined) {
			clearTimeout(this.#backpressureDrainTimer);
			this.#backpressureDrainTimer = undefined;
		}
	}

	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		this.#clearBackpressureDrain();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#pendingSends.length = 0;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {}
		}
		if (hadActivity && !wasClosed) this.onClose?.("closed", false);
	}

	#openSocket(): void {
		this.#clearBackpressureDrain();
		const ws = new WebSocket(`${this.#opts.wsUrl}?role=${this.#opts.role}`);
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#attempt = 0;
			if (this.#pendingSends.length > 0) {
				this.#drainPendingSends(ws);
				if (this.#pendingSends.length > 0) this.#scheduleBackpressureDrain(ws);
			}
			this.onOpen?.();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#handleMessage(ws, event.data);
		};
		ws.onerror = () => {};
		ws.onclose = (event: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#clearBackpressureDrain();
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		if (typeof data === "string") {
			try {
				this.onControl?.(JSON.parse(data) as RelayControlMessage);
			} catch {
				logger.debug("collab: ignoring malformed control message");
			}
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) return;
		const envelope = unpackEnvelope(bytes);
		if (!envelope) return;
		this.#recvChain = this.#recvChain
			.then(async () => {
				if (this.#ws !== ws) return;
				let frame: CollabFrame;
				try {
					frame = await open(this.#opts.key, envelope.payload);
				} catch {
					this.#failFatal("bad key or corrupted frame");
					return;
				}
				if (this.#ws !== ws) return;
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch((err: unknown) => {
				logger.debug("collab: frame handler failed", { error: String(err) });
			});
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		this.#clearBackpressureDrain();
		const fatalReason = RELAY_FATAL_CLOSE_REASONS[code];
		if (fatalReason !== undefined) {
			this.#closed = true;
			this.#pendingSends.length = 0;
			this.onClose?.(fatalReason, false);
			return;
		}
		this.onClose?.(reason || `connection lost (code ${code})`, true);
		this.#scheduleRetry();
	}

	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#pendingSends.length = 0;
		const ws = this.#ws;
		this.#ws = null;
		this.#clearBackpressureDrain();
		if (ws) {
			try {
				ws.close(1000);
			} catch {}
		}
		this.onClose?.(reason, false);
	}

	#scheduleRetry(): void {
		const delay = exponentialBackoffDelay(this.#attempt);
		this.#attempt++;
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			if (this.#closed) return;
			this.#openSocket();
		}, delay);
	}

	#clearRetry(): void {
		if (this.#retryTimer !== undefined) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
	}
}
