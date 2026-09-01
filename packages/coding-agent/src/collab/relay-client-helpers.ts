export const WS_BACKPRESSURE_THRESHOLD = 64 * 1024;
export const WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 * 1024;
export const WS_BACKPRESSURE_DRAIN_RETRY_MS = 25;

export interface CollabSocketOptions {
	wsUrl: string;
	role: "host" | "guest";
	key: CryptoKey;
}
