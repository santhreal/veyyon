/** Collab relay protocol control messages, fatal close codes, and send bounds. */

/** Relay → host control message. */
export type RelayControlToHost = { t: "peer-joined" | "peer-left"; peer: number };
/** Relay → guest control message. */
export type RelayControlToGuest = { t: "room-closed" };
export type RelayControlMessage = RelayControlToHost | RelayControlToGuest;

/** Every close code that means do not reconnect, mapped to user-facing reason. */
export const RELAY_FATAL_CLOSE_REASONS: Readonly<Record<number, string>> = {
	4001: "room closed",
	4004: "no such room",
	4009: "a host is already connected for this room",
	4029: "room is full",
};

/** Whether a close code is fatal. */
export function isRelayFatalCloseCode(code: number): boolean {
	return Object.hasOwn(RELAY_FATAL_CLOSE_REASONS, code);
}

/** The reason to show for a fatal close, or `undefined` when the code is transient and a retry is correct. */
export function relayFatalCloseReason(code: number): string | undefined {
	return isRelayFatalCloseCode(code) ? RELAY_FATAL_CLOSE_REASONS[code] : undefined;
}

/** Max sealed frames buffered during pending reconnect before dropping. */
export const RELAY_MAX_PENDING_SENDS = 256;
