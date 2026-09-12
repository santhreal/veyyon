/**
 * Collab link grammar: `wss://<host[:port]>/r/<roomId>.<base64url-32-byte-key>`.
 *
 * The host mints the link the browser guest parses, so the grammar is a wire
 * format like the envelope codec and the frame sealing, and it is defined once,
 * here. base64url goes through `atob`/`btoa` rather than `Buffer` so the browser
 * guest imports this module directly; the Node host reads the same bytes.
 *
 * Owned by this leaf, which imports nothing, so a link parser pays one module
 * for the grammar instead of the whole `@veyyon/wire` barrel. The barrel
 * re-exports everything here.
 */

export const ROOM_ID_BYTES = 16;

/** AES-256-GCM room key; the seal key for every collab frame. */
export const ROOM_KEY_BYTES = 32;

/**
 * Random write token appended to the room key in full links
 * (`base64url(key ∥ token)`); view links carry the bare key. Possession
 * proves prompt/abort/agent-cmd capability to the host.
 */
export const WRITE_TOKEN_BYTES = 16;

/**
 * Default public relay; bare `<roomId>.<key>` links resolve against it.
 *
 * Points at the Veyyon-owned relay host. As of this writing `veyyon.dev` has
 * no live DNS/relay deployed yet — `/collab` against the default (no
 * `--relay` override) will fail to connect until that infra ships. Repoint
 * or override via `collab.relayUrl` once a real relay is standing.
 */
export const DEFAULT_RELAY_URL = "wss://share.veyyon.dev";

export interface ParsedCollabLink {
	/** wss://host[:port]/r/<roomId> — no query, no fragment. */
	wsUrl: string;
	roomId: string;
	key: Uint8Array;
	/** Write token from a full link; absent for read-only (view) links. */
	writeToken?: Uint8Array;
}

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const LOCAL_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

// ═══════════════════════════════════════════════════════════════════════════
// base64url (no Buffer: the browser guest runs this)
// ═══════════════════════════════════════════════════════════════════════════

export function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Null when `text` is not base64url, the same answer a wrong-length key gets from the parser. */
export function decodeBase64Url(text: string): Uint8Array | null {
	if (!B64URL_RE.test(text)) return null;
	const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.length % 4 === 0 ? base64 : base64 + "=".repeat(4 - (base64.length % 4));
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		return null;
	}
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// Link format
// ═══════════════════════════════════════════════════════════════════════════

/** Hosts a plain `ws://` relay or an `http://` web base is accepted for. */
export function isLocalHostname(hostname: string): boolean {
	return LOCAL_HOSTNAMES[hostname] === true;
}

export function generateRoomId(): string {
	const bytes = new Uint8Array(ROOM_ID_BYTES);
	crypto.getRandomValues(bytes);
	return encodeBase64Url(bytes);
}

/** Normalize a relay base URL (ws/wss/http/https) into a ws/wss origin, or an error. */
export function normalizeRelayOrigin(relayUrl: string): { origin: string } | { error: string } {
	let url: URL;
	try {
		url = new URL(relayUrl);
	} catch {
		return { error: `Invalid relay URL: ${relayUrl}` };
	}
	let scheme: string;
	switch (url.protocol) {
		case "wss:":
		case "https:":
			scheme = "wss:";
			break;
		case "ws:":
		case "http:":
			scheme = "ws:";
			break;
		default:
			return { error: `Unsupported relay URL scheme: ${url.protocol}` };
	}
	if (scheme === "ws:" && !isLocalHostname(url.hostname)) {
		return { error: "relay link must be wss:// (plain ws:// is only allowed for localhost)" };
	}
	const port = url.port ? `:${url.port}` : "";
	return { origin: `${scheme}//${url.hostname}${port}` };
}

/**
 * Render the payload half of a link: `<roomId>.<key>` for the default relay,
 * `host[:port]/r/<roomId><joiner><key>` for another wss relay, and a full URL
 * for a localhost ws:// relay so parsing cannot mis-infer wss.
 *
 * The web deep link nests this text inside its own fragment with a `.` joiner:
 * RFC 3986 forbids a raw `#` inside a fragment, so strict URL stacks (macOS
 * Foundation behind terminal click-to-open) percent-encode a second `#` to
 * `%23` and break the link. Parsers accept the `#` form and the mangled `%23`
 * form too.
 *
 * Full links append the write token to the key
 * (`base64url(key ∥ writeToken)`); read-only (view) links carry the bare
 * 32-byte key, which is also the pre-token link format.
 */
export function formatCollabLinkPayload(
	relayUrl: string,
	roomId: string,
	key: Uint8Array,
	writeToken: Uint8Array | undefined,
	joiner: string,
): string {
	const normalized = normalizeRelayOrigin(relayUrl);
	if ("error" in normalized) throw new Error(normalized.error);
	let secret = key;
	if (writeToken) {
		secret = new Uint8Array(key.byteLength + writeToken.byteLength);
		secret.set(key, 0);
		secret.set(writeToken, key.byteLength);
	}
	const keyText = encodeBase64Url(secret);
	// The default relay collapses to a hostless `<roomId>.<key>`. There is no
	// authority for a terminal to linkify, so the secret cannot become a
	// request line, and the dot is required: this exact text is what gets
	// nested in the web deep link's fragment.
	if (normalized.origin === DEFAULT_RELAY_URL) return `${roomId}.${keyText}`;
	const compact = normalized.origin.startsWith("wss://")
		? normalized.origin.slice("wss://".length)
		: normalized.origin;
	return `${compact}/r/${roomId}${joiner}${keyText}`;
}

/**
 * Render the shareable link a human sees and pastes.
 *
 * When the link names a relay host, the secret rides in the fragment
 * (`host/r/<roomId>#<key>`) and never in the path. Terminals linkify
 * `host/r/…` and open it as `https://…`; with the secret dot-joined into the
 * path, one click on your own link puts the AES-256-GCM room key and the
 * write token in the relay's HTTP request line, and from there into its
 * access log and any TLS-terminating proxy in front of it. A fragment is
 * never sent to the server, so a click discloses only `/r/<roomId>`, which
 * the WebSocket handshake reveals anyway.
 *
 * Only one `#` appears here, so the nested-fragment escaping problem that
 * forces the dot-joined payload form does not apply.
 */
export function formatCollabLink(relayUrl: string, roomId: string, key: Uint8Array, writeToken?: Uint8Array): string {
	return formatCollabLinkPayload(relayUrl, roomId, key, writeToken, "#");
}

export function parseCollabLink(link: string): ParsedCollabLink | { error: string } {
	// Lenient input: terminals that open OSC 8 links through strict URL stacks
	// (macOS Foundation) percent-encode the legacy second `#` to `%23`.
	let text = link.trim().replace(/%23/gi, "#");
	// Bare `<roomId>.<key>` (legacy `<roomId>#<key>`) → default relay.
	const bare = BARE_LINK_RE.exec(text);
	if (bare) text = `${DEFAULT_RELAY_URL}/r/${bare[1]}.${bare[2]}`;
	// Scheme-less `host[:port]/r/…` → wss.
	else if (!text.includes("://")) text = `wss://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return { error: `Invalid collab link: ${link}` };
	}
	if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		const parsed = parseCollabLink(inner);
		if (!("error" in parsed)) return parsed;
	}
	const normalized = normalizeRelayOrigin(url.origin);
	if ("error" in normalized) return normalized;
	const match = ROOM_PATH_RE.exec(url.pathname);
	if (!match) {
		// Non-http(s) deep links may also carry a complete collab link in the
		// fragment. http(s) links are handled once above so invalid fragments
		// fall through to direct relay validation instead of double-recursing.
		const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
		if (inner && url.protocol !== "http:" && url.protocol !== "https:") return parseCollabLink(inner);
		return { error: "Collab link must contain a /r/<roomId> path" };
	}
	const roomId = match[1] as string;
	// Key rides dot-joined in the path (`/r/<roomId>.<key>`); legacy links
	// carry it in the fragment (`/r/<roomId>#<key>`).
	const fragment = match[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
	if (!fragment) {
		return { error: "Collab link is missing the <key> part" };
	}
	const secret = decodeBase64Url(fragment);
	if (!secret || (secret.byteLength !== ROOM_KEY_BYTES && secret.byteLength !== ROOM_KEY_BYTES + WRITE_TOKEN_BYTES)) {
		return { error: "Collab link key must be 32 (view) or 48 (full) base64url bytes" };
	}
	const key = secret.subarray(0, ROOM_KEY_BYTES);
	const writeToken = secret.byteLength > ROOM_KEY_BYTES ? secret.subarray(ROOM_KEY_BYTES) : undefined;
	return { wsUrl: `${normalized.origin}/r/${roomId}`, roomId, key, writeToken };
}
