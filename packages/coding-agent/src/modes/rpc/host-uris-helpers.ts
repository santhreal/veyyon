import type { RpcHostUriCancelRequest, RpcHostUriRequest, RpcHostUriResult } from "./rpc-types";

export type RpcHostUriOutput = (frame: RpcHostUriRequest | RpcHostUriCancelRequest) => void;

export type PendingUriRequest = {
	operation: "read" | "write";
	url: string;
	resolve: (frame: RpcHostUriResult) => void;
	reject: (error: Error) => void;
};

/** Type guard for inbound `host_uri_result` frames coming from the host. */
export function isRpcHostUriResult(value: unknown): value is RpcHostUriResult {
	if (!value || typeof value !== "object") return false;
	const frame = value as { type?: unknown; id?: unknown };
	return frame.type === "host_uri_result" && typeof frame.id === "string";
}

/** One handler instance per host-registered scheme. Delegates reads and (when the scheme was registered as writable) writes to the bridge, which serializes */
