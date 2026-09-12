/**
 * Collab link + wire-envelope handling for the browser guest.
 *
 * Link format: `wss://<host[:port]>/r/<roomId>.<base64url-32-byte-key>`
 * Wire envelope: `[4B uint32 BE peerId][sealed payload]` — the guest always
 * sends peerId 0; the relay rewrites it to the sender's id.
 *
 * Every helper is `@veyyon/wire`'s, next to the constants it reads, because the
 * host mints the links and writes the envelopes this client parses: two copies of
 * the grammar or of the byte order is two chances to disagree. Re-exported so the
 * rest of the client keeps importing its link helpers from one module.
 */

export type { ParsedCollabLink } from "@veyyon/wire";
export {
	COLLAB_PROTO,
	DEFAULT_RELAY_URL,
	decodeBase64Url,
	ENVELOPE_HEADER_LENGTH,
	encodeBase64Url,
	formatCollabLink,
	generateRoomId,
	packEnvelope,
	parseCollabLink,
	ROOM_ID_BYTES,
	rewriteEnvelopePeer,
	unpackEnvelope,
} from "@veyyon/wire";
