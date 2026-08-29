import type { DapEventMessage, DapResolvedAdapter } from "./types";

export interface DapSpawnOptions {
	adapter: DapResolvedAdapter;
	cwd: string;
	socketReadyTimeoutMs?: number;
}

export interface DapWriteSink {
	write(data: string | Uint8Array): number | Promise<number>;
	flush(): number | Promise<number> | undefined;
}

export type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
export type DapReverseRequestHandler = (args: unknown) => unknown | Promise<unknown>;

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const WRITE_MESSAGE_TIMEOUT_MS = 30_000;
export const SOCKET_READY_TIMEOUT_MS = 10_000;
