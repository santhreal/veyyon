import type { SimpleStreamOptions } from "../types";

export const NON_WIRE_KEYS = new Set<keyof SimpleStreamOptions>([
	"signal",
	"apiKey",
	"fetch",
	"onPayload",
	"onResponse",
	"onSseEvent",
	"execHandlers",
	"cursorExecHandlers",
	"cursorOnToolResult",
	"providerSessionState",
]);
export const VEYYON_NATIVE_STREAM_IDLE_TIMEOUT_ERROR = "pi-native stream stalled while waiting for the next event";
export const VEYYON_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR =
	"pi-native stream timed out while waiting for the first event";
