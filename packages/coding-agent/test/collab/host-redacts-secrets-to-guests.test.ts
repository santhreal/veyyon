/**
 * WHY: a collab link is a bearer capability the operator may have forwarded once, and the host
 * replicated the transcript to whoever holds it verbatim. `/share` ran the configured secrets
 * through the obfuscator first; the collab host called it nowhere, so a guest received the literal
 * value of a secret that appeared in any tool output while the same content routed through
 * `/share` would have been a placeholder.
 *
 * The contract these tests defend, driven through the real host, the real relay transport and a
 * real guest socket:
 *   - the snapshot a joining guest receives carries placeholders, not secret values;
 *   - so does a live frame broadcast after the join, which is a different send site;
 *   - ordinary transcript text is untouched, so this is not a blanket scrub;
 *   - with `share.redactSecrets` off the operator still gets the verbatim stream they asked for.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { importRoomKey } from "@veyyon/coding-agent/collab/crypto";
import { CollabHost } from "@veyyon/coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@veyyon/coding-agent/collab/protocol";
import { CollabSocket } from "@veyyon/coding-agent/collab/relay-client";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import type { SessionEntry } from "@veyyon/coding-agent/session/session-entries";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

const SECRET = "sk-live-COLLABLEAK-0123456789";
const obfuscator = new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET }]);
const PLACEHOLDER = obfuscator.obfuscate(SECRET);

const snapshot = {
	header: { type: "session", id: "sess-redact", timestamp: "2026-08-05T00:00:00Z", cwd: "/tmp/proj" },
	entries: [
		{
			type: "message",
			id: "e0",
			parentId: null,
			timestamp: "2026-08-05T00:00:01Z",
			message: { role: "user", content: `read .env: API_KEY=${SECRET} and PORT=8080`, timestamp: 0 },
		},
	] as SessionEntry[],
};

function makeHostContext(redactSecrets: boolean): InteractiveModeContext {
	return {
		settings: { get: (key: string) => (key === "share.redactSecrets" ? redactSecrets : "") },
		sessionManager: {
			getSessionId: () => snapshot.header.id,
			getCwd: () => snapshot.header.cwd,
			snapshotForReplication: () => snapshot,
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "redact",
			model: undefined,
			thinkingLevel: undefined,
			providerRedactor: obfuscator,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

let host: CollabHost;
let ctx: InteractiveModeContext;
const cleanups: (() => void)[] = [];

async function joinGuest(): Promise<{ frames: CollabFrame[]; joined: Promise<void>; socket: CollabSocket }> {
	const parsed = parseCollabLink(host.link);
	if ("error" in parsed) throw new Error(parsed.error);
	const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
	const socket = new CollabSocket({
		wsUrl: parsed.wsUrl,
		role: "guest",
		key: await importRoomKey(parsed.key),
	});
	cleanups.push(() => socket.close());

	const frames: CollabFrame[] = [];
	const done = Promise.withResolvers<void>();
	socket.onFrame = frame => {
		frames.push(frame);
		if (frame.t === "snapshot-chunk" && frame.final) done.resolve();
	};
	socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "guest", writeToken });
	socket.connect();
	return { frames, joined: done.promise, socket };
}

async function startHost(redactSecrets: boolean): Promise<void> {
	ctx = makeHostContext(redactSecrets);
	host = new CollabHost(ctx);
	await host.start("ws://localhost:8788");
}

beforeEach(() => {
	installInMemoryRelay();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	await host?.stop("test done").catch(() => {});
	uninstallInMemoryRelay();
});

describe("collab host secret redaction", () => {
	it("replaces a secret in the snapshot a joining guest receives", async () => {
		await startHost(true);
		const guest = await joinGuest();
		await guest.joined;

		const wire = JSON.stringify(guest.frames);
		expect(wire).not.toContain(SECRET);
		expect(wire).toContain(PLACEHOLDER);
	});

	it("replaces a secret in a live entry broadcast after the guest joined", async () => {
		await startHost(true);
		const guest = await joinGuest();
		await guest.joined;
		const before = guest.frames.length;

		const live = Promise.withResolvers<CollabFrame>();
		guest.socket.onFrame = frame => {
			guest.frames.push(frame);
			if (frame.t === "entry") live.resolve(frame);
		};
		ctx.sessionManager.onEntryAppended?.({
			type: "message",
			id: "e1",
			parentId: "e0",
			timestamp: "2026-08-05T00:00:02Z",
			message: { role: "user", content: `later leak ${SECRET}`, timestamp: 0 },
		} as SessionEntry);

		const frame = await live.promise;
		expect(guest.frames.length).toBeGreaterThan(before);
		const wire = JSON.stringify(frame);
		expect(wire).not.toContain(SECRET);
		expect(wire).toContain(`later leak ${PLACEHOLDER}`);
	});

	it("leaves ordinary transcript text and frame structure intact", async () => {
		await startHost(true);
		const guest = await joinGuest();
		await guest.joined;

		const welcome = guest.frames.find(f => f.t === "welcome");
		if (welcome?.t !== "welcome") throw new Error("expected a welcome frame");
		expect(welcome.header.id).toBe("sess-redact");
		expect(welcome.entryCount).toBe(1);
		expect(JSON.stringify(guest.frames)).toContain("PORT=8080");
	});

	it("streams verbatim when share.redactSecrets is off", async () => {
		await startHost(false);
		const guest = await joinGuest();
		await guest.joined;

		expect(JSON.stringify(guest.frames)).toContain(SECRET);
	});
});
