/**
 * WHY THIS SUITE EXISTS
 *
 * A take of the share surface has to photograph a participant row, and a row is
 * only worth photographing if somebody is actually on the other end of the
 * relay. The cheap way to get one is to draw a fake: seed the roster, or point
 * the harness at a stub that answers whatever the scene asks for. Then the
 * frame proves nothing, and nothing in the pipeline can tell the difference,
 * because a fake participant photographs exactly like a real one.
 *
 * So `proof/lib/collab-guest.ts` speaks the real protocol, and this suite holds
 * it to that: it runs the offline relay `clients/web/scripts/local-relay.ts`,
 * mints a link with the same `@veyyon/wire` helpers the host mints links with,
 * and opens the frame the guest sent with the room key. A harness that sent
 * anything a host would reject fails here rather than in a recording session.
 *
 * THE CLASS THIS CLOSES. Not "the hello frame was malformed once". Every way
 * the harness can drift out of the protocol it claims to speak -- a changed
 * envelope layout, a renamed frame field, a protocol number bump, a write token
 * encoded in an alphabet the host does not read, a link grammar that gains a
 * component -- surfaces as an unopenable or wrong frame in these assertions,
 * because nothing here restates the grammar. Both link kinds are covered, so a
 * read-only join cannot silently acquire write capability.
 *
 * WHAT IT DOES NOT CATCH. Whether the HOST accepts the peer: that is
 * `CollabHost`'s own suites, and this one deliberately stops at the bytes,
 * because a take of the window is the thing that proves the two ends meet. It
 * also says nothing about what the window draws for a participant.
 */
import {
	encodeBase64Url,
	formatCollabLink,
	generateRoomId,
	generateRoomKey,
	generateWriteToken,
	importRoomKey,
	openFrame,
	unpackEnvelope,
} from "@veyyon/wire";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { startLocalRelay, type LocalRelay } from "../clients/web/scripts/local-relay";

const HARNESS = path.join(import.meta.dirname, "lib", "collab-guest.ts");

interface HelloFrame {
	t: string;
	proto: number;
	name: string;
	writeToken?: string;
}

interface Joined {
	peerId: number;
	frame: HelloFrame;
}

let relay: LocalRelay;

beforeAll(() => {
	relay = startLocalRelay(0);
});

afterAll(() => {
	relay.stop();
});

/**
 * Host one room, run the harness against its link, and return the first frame
 * the room received, opened with the room key.
 */
async function hostAndJoin(args: string[], view: boolean): Promise<Joined> {
	const roomId = generateRoomId();
	const keyBytes = generateRoomKey();
	const key = await importRoomKey(keyBytes);
	const origin = relay.url.replace(/^http/, "ws");
	const host = new WebSocket(`${origin}/r/${roomId}?role=host`);
	host.binaryType = "arraybuffer";
	const arrived = Promise.withResolvers<Joined>();

	host.addEventListener("message", event => {
		if (typeof event.data === "string") return;
		const envelope = unpackEnvelope(new Uint8Array(event.data as ArrayBuffer));
		if (!envelope) return;
		openFrame<HelloFrame>(key, envelope.payload)
			.then(frame => arrived.resolve({ peerId: envelope.peerId, frame }))
			.catch((reason: unknown) => arrived.reject(new Error(`the frame did not open: ${String(reason)}`)));
	});
	await new Promise<void>(resolve => host.addEventListener("open", () => resolve()));

	const link = formatCollabLink(origin, roomId, keyBytes, view ? undefined : generateWriteToken());
	const guest = Bun.spawn(["bun", HARNESS, link, ...args], { stdout: "pipe", stderr: "pipe" });
	const timeout = setTimeout(() => arrived.reject(new Error("no frame reached the room")), 15_000);
	// The harness holds its connection open until it is killed, so its stdout
	// never reaches EOF while it is alive and is not read here: what this suite
	// judges is the bytes that arrived in the room.
	try {
		return await arrived.promise;
	} finally {
		clearTimeout(timeout);
		guest.kill();
		host.close();
	}
}

describe("a guest joins a share with the link it was given", () => {
	it("greets the room the link names, in the protocol the host reads", async () => {
		const { peerId, frame } = await hostAndJoin(["--name=Wren"], false);
		// The relay stamps the sender, so the host learns which peer this is
		// without the guest claiming an identity in the envelope.
		expect(peerId).toBe(1);
		expect(frame.t).toBe("hello");
		expect(frame.name).toBe("Wren");
		const { COLLAB_PROTO } = await import("@veyyon/wire");
		expect(frame.proto).toBe(COLLAB_PROTO);
	}, 30_000);

	it("carries the write token a full link grants, in the alphabet the host decodes", async () => {
		const { frame } = await hostAndJoin(["--name=Wren"], false);
		expect(typeof frame.writeToken).toBe("string");
		// The bytes the token stands for, not merely a string: a token in the
		// wrong alphabet decodes to the wrong bytes and the host reads it as a
		// viewer, which is a difference no length check can see.
		const decoded = Buffer.from((frame.writeToken ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
		expect(decoded.byteLength).toBe(16);
		expect(encodeBase64Url(new Uint8Array(decoded))).toBe(frame.writeToken);
	}, 30_000);

	it("sends no write token when the link is read-only", async () => {
		const { frame } = await hostAndJoin(["--name=Vera"], true);
		expect(frame.writeToken).toBeUndefined();
	}, 30_000);

	it("sends no write token when a full link is joined as a viewer", async () => {
		const { frame } = await hostAndJoin(["--name=Vera", "--read-only"], false);
		expect(frame.writeToken).toBeUndefined();
	}, 30_000);

	it("refuses a link it cannot parse, without opening a connection", async () => {
		const guest = Bun.spawn(["bun", HARNESS, "not-a-link", "--name=Wren"], { stdout: "pipe", stderr: "pipe" });
		const code = await guest.exited;
		expect(code).toBe(2);
		expect(await new Response(guest.stderr).text()).toContain("collab-guest:");
	}, 30_000);

	it("refuses an option it does not offer, rather than joining under a default", async () => {
		const guest = Bun.spawn(["bun", HARNESS, "--nope"], { stdout: "pipe", stderr: "pipe" });
		expect(await guest.exited).toBe(2);
		expect(await new Response(guest.stderr).text()).toContain("unknown option --nope");
	}, 30_000);
});
