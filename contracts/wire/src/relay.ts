/**
 * The collab relay protocol: its control messages, its fatal close codes, and the client-side send bound.
 *
 * WHY THESE LIVE TOGETHER AND IN THIS PACKAGE. Two independent clients speak this protocol, the CLI's
 * `collab/relay-client.ts` in `@veyyon/coding-agent` and the browser's `lib/socket.ts` in
 * `@veyyon/collab-web`, and a third program, the relay itself, decides the codes. Each client carried its own
 * copy of the fatal-code table, character for character, doc comment included, and its own
 * `MAX_PENDING_SENDS = 256`.
 *
 * A close code the table does not know is treated as TRANSIENT, so the client reconnects. That is the whole
 * consequence: add a fatal code to the relay, teach one client about it, and the other reconnects in a loop
 * against a condition that will never clear, backing off to thirty seconds and staying there. Nothing throws
 * and nothing logs an error, because from that client's point of view it is doing the right thing.
 *
 * This module has NO imports, so a client pays one module for the protocol rather than the 900-line message
 * barrel it lives next to. `index.ts` re-exports everything here, so anything that already imported the
 * relay types from `@veyyon/wire` is unchanged.
 */

/** Relay → host control message. */
export type RelayControlToHost = { t: "peer-joined" | "peer-left"; peer: number };
/** Relay → guest control message. */
export type RelayControlToGuest = { t: "room-closed" };
export type RelayControlMessage = RelayControlToHost | RelayControlToGuest;

/**
 * Every close code that means "do not reconnect", with the reason to show the user.
 *
 * A code absent from this table is transient by definition, which is why the table is the protocol and not a
 * convenience: adding a code here is what makes a client stop retrying, and a client that does not know the
 * code retries forever instead.
 *
 * The four codes are in the 4000-4999 range WebSocket reserves for application use:
 *
 * - `4001` the host left, so the room no longer exists
 * - `4004` the room id was never valid, or expired before the join
 * - `4009` a host is already connected, so this would be a second host for one room
 * - `4029` the room is at capacity
 *
 * The strings are user-facing and are shown as the reason a session ended, so they read as sentences rather
 * than as codes.
 */
export const RELAY_FATAL_CLOSE_REASONS: Readonly<Record<number, string>> = {
	4001: "room closed",
	4004: "no such room",
	4009: "a host is already connected for this room",
	4029: "room is full",
};

/**
 * Whether a close code is fatal, meaning the client must surface the reason and stay down.
 *
 * Preferred over indexing the table directly, so a caller cannot accidentally treat the empty string as
 * "not fatal" if a reason is ever blank.
 */
export function isRelayFatalCloseCode(code: number): boolean {
	return Object.hasOwn(RELAY_FATAL_CLOSE_REASONS, code);
}

/** The reason to show for a fatal close, or `undefined` when the code is transient and a retry is correct. */
export function relayFatalCloseReason(code: number): string | undefined {
	return isRelayFatalCloseCode(code) ? RELAY_FATAL_CLOSE_REASONS[code] : undefined;
}

/**
 * How many sealed frames a client buffers while a reconnect is pending, before it starts dropping them.
 *
 * Dropping is safe rather than lossy: the relay's welcome resync replays state on reopen, so a dropped frame
 * costs latency and not correctness. The bound exists so a client that is offline for a long time cannot grow
 * its buffer without limit.
 *
 * Both clients had their own copy of this number, which is a subtler problem than the close codes: the two
 * ends of a session with different buffer depths behave differently under the same network, and the symptom
 * is one participant's edits arriving after a reconnect while the other's are silently gone.
 */
export const RELAY_MAX_PENDING_SENDS = 256;
