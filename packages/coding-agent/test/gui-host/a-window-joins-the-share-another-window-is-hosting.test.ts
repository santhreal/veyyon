/**
 * WHY THIS SUITE EXISTS
 *
 * A window could host a share and not join one. `/join` and `/leave` were the
 * last two commands the terminal offered that the desktop reached by nothing:
 * the guest replication lived behind a context made of terminal components, so
 * the only host that could hold a room was the one drawing a chat container.
 *
 * It drives two real GUI hosts over real sockets against the in-memory relay,
 * so a join here is the same handshake, the same replica file and the same
 * session switch a window performs, read back as the bytes it would decode.
 *
 * THE CLASS THIS CLOSES: a guest seam that exists on one host and not the
 * other. Every side of the join is reached — the action, the command, the
 * refusals either side of it, the leave, and the host ending the room under a
 * guest that did not ask to leave — and each is read back through the `Share`
 * section rather than through the bridge's own fields, so a transition that
 * publishes a stale card, or none, fails.
 *
 * WHAT IT DOES NOT CATCH: what the window DRAWS for any of it, which the
 * surface crate's suites own; and the replication itself, which the collab
 * suites drive frame by frame. What is asserted here is that a joined window
 * is on the host's session and a left one is back on its own.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { SessionHeaderView, ShareView } from "../../src/gui-host/wire";
import { installInMemoryRelay, uninstallInMemoryRelay } from "../collab/helpers/in-memory-relay";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { type RequestFrame, snapshotSections, TestSocketClient } from "./test-client";

const RELAY = "ws://localhost:8788";

interface Window {
	dir: string;
	server: GuiHostServer;
	client: TestSocketClient;
	session: string;
}

function lastShare(frames: RequestFrame[]): ShareView {
	const shares = snapshotSections<ShareView>(frames, "Share");
	expect(shares.length).toBeGreaterThan(0);
	return shares[shares.length - 1];
}

function lastHeader(frames: RequestFrame[]): SessionHeaderView {
	const headers = snapshotSections<{ value: SessionHeaderView }>(frames, "ActiveSession");
	expect(headers.length).toBeGreaterThan(0);
	return headers[headers.length - 1].value;
}

describe("a window joins the share another window is hosting", () => {
	useIsolatedConfigRoot();
	let host: Window;
	let guest: Window;
	let id = 0;

	/** The next request id, so no two requests in one test collide. */
	const next = (): number => {
		id += 1;
		return id;
	};

	async function openWindow(label: string): Promise<Window> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), `gui-host-join-${label}-`));
		const server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: dir,
			agentDir: dir,
			authStorage: await isolatedAuthStorage(dir),
		});
		const client = await TestSocketClient.connect(server.endpoint);
		// The greeting and the capability frames arrive unasked.
		await client.nextFrame();
		await client.nextFrame();
		await client.request(next(), { SetSetting: { key: "collab.relayUrl", value: RELAY } });
		const created = await client.request(next(), { CreateSession: { title: label } });
		return { dir, server, client, session: lastHeader(created.frames).id };
	}

	/** The share this window last stated, waiting for one that satisfies `want`. */
	async function shareOn(window: Window, want: (share: ShareView) => boolean): Promise<ShareView> {
		const deadline = Date.now() + 10000;
		let share: ShareView | undefined;
		for (;;) {
			const refreshed = await window.client.request(next(), "RefreshShare");
			share = lastShare(refreshed.frames);
			if (want(share)) return share;
			if (Date.now() > deadline) {
				throw new Error(`the share stayed ${share.state}/${share.role} past the deadline`);
			}
			await new Promise(resolve => setTimeout(resolve, 25));
		}
	}

	async function startedLink(): Promise<string> {
		const started = await host.client.request(next(), { StartShare: { read_only: false } });
		const share = lastShare(started.frames);
		expect(share.state).toBe("hosting");
		expect(share.role).toBe("Hosting");
		expect(share.link).toBeTruthy();
		return share.link as string;
	}

	beforeEach(async () => {
		installInMemoryRelay();
		host = await openWindow("host");
		guest = await openWindow("guest");
	});

	afterEach(async () => {
		uninstallInMemoryRelay();
		for (const window of [guest, host]) {
			window?.client?.destroy();
			await window?.server?.close();
			if (window?.dir) await fs.rm(window.dir, { recursive: true, force: true });
		}
	});

	test("a joined window states the room it is in and sits on the host's session", async () => {
		const link = await startedLink();

		const joined = await guest.client.request(next(), { JoinShare: { session: guest.session, link } });
		expect(joined.outcome.RequestFailed).toBeUndefined();
		const share = lastShare(joined.frames);
		expect(share.state).toBe("joined");
		expect(share.role).toBe("Guest");
		expect(share.guest).not.toBeNull();
		expect(share.guest?.read_only).toBe(false);
		expect(share.guest?.connected).toBe(true);
		expect(share.guest?.room).toBeTruthy();
		// A guest holds no link to hand on: the room is the host's to share.
		expect(share.link).toBeNull();

		// The window is on the replica, whose header carries the HOST's session
		// id and directory. A guest that stayed on its own session states its
		// own, which is what a join that replicated nothing looks like.
		const header = lastHeader(joined.frames);
		expect(header.id).toBe(host.session);
		expect(path.resolve(header.cwd)).toBe(path.resolve(host.dir));
	});

	test("leaving puts the window back on the session it joined from", async () => {
		const link = await startedLink();
		await guest.client.request(next(), { JoinShare: { session: guest.session, link } });

		const left = await guest.client.request(next(), "LeaveShare");
		expect(left.outcome.RequestFailed).toBeUndefined();
		const share = lastShare(left.frames);
		expect(share.state).toBe("off");
		expect(share.role).toBe("Off");
		expect(share.guest).toBeNull();
		expect(share.relay_url).toBe(RELAY);
		// Back on its own session, not left holding the host's replica.
		const header = lastHeader(left.frames);
		expect(header.id).toBe(guest.session);
		expect(path.resolve(header.cwd)).toBe(path.resolve(guest.dir));
	});

	test("/join and /leave run the same bridge the card does", async () => {
		const link = await startedLink();

		const ran = await guest.client.request(next(), { RunCommand: { session: guest.session, text: `/join ${link}` } });
		expect(ran.outcome.RequestFailed).toBeUndefined();
		expect(lastShare(ran.frames).state).toBe("joined");

		const out = await guest.client.request(next(), { RunCommand: { session: guest.session, text: "/leave" } });
		expect(out.outcome.RequestFailed).toBeUndefined();
		expect(lastShare(out.frames).state).toBe("off");
	});

	test("/join with no link fails the request rather than prompting the model", async () => {
		const ran = await guest.client.request(next(), { RunCommand: { session: guest.session, text: "/join" } });
		expect(ran.outcome.RequestFailed?.error.code).toBe("INVALID_ARGUMENTS");
		expect(ran.outcome.RequestFailed?.error.message).toContain("/join <link>");
	});

	test("a link that names no room leaves the card off, carrying the reason", async () => {
		const failed = await guest.client.request(next(), {
			JoinShare: { session: guest.session, link: "not-a-collab-link" },
		});
		expect(failed.outcome.RequestFailed?.error.code).toBe("JOIN_SHARE_FAILED");

		const share = await shareOn(guest, current => current.state === "off");
		expect(share.role).toBe("Off");
		expect(share.guest).toBeNull();
	});

	test("a window hosting a share refuses to join one, and a guest refuses to host", async () => {
		const link = await startedLink();

		const joinWhileHosting = await host.client.request(next(), { JoinShare: { session: host.session, link } });
		expect(joinWhileHosting.outcome.RequestFailed?.error.code).toBe("ALREADY_HOSTING");
		expect(lastShare(await hostShare()).state).toBe("hosting");

		await guest.client.request(next(), { JoinShare: { session: guest.session, link } });
		const hostWhileGuest = await guest.client.request(next(), { StartShare: { read_only: false } });
		expect(hostWhileGuest.outcome.RequestFailed?.error.code).toBe("ALREADY_A_GUEST");
	});

	test("a second join while one is live is refused rather than replacing it", async () => {
		const link = await startedLink();
		await guest.client.request(next(), { JoinShare: { session: guest.session, link } });

		const second = await guest.client.request(next(), { JoinShare: { session: guest.session, link } });
		expect(second.outcome.RequestFailed?.error.code).toBe("JOIN_SHARE_FAILED");
		expect(second.outcome.RequestFailed?.error.message).toContain("already");
		const share = await shareOn(guest, current => current.role === "Guest");
		expect(share.state).toBe("joined");
	});

	test("a host that stops the share takes the guest out of it", async () => {
		const link = await startedLink();
		await guest.client.request(next(), { JoinShare: { session: guest.session, link } });

		await host.client.request(next(), "StopShare");

		const share = await shareOn(guest, current => current.state === "off");
		expect(share.role).toBe("Off");
		expect(share.guest).toBeNull();
	}, 20000);

	// One spelling, one behaviour: `/leave` in the terminal ends a hosted
	// share as well as a joined one, and the action the card sends is the
	// same path, so a host that leaves is a host that stopped.
	test("leaving from the hosting side stops the share the window was hosting", async () => {
		await startedLink();

		await host.client.request(next(), "LeaveShare");

		const share = lastShare(await hostShare());
		expect(share.state).toBe("off");
		expect(share.role).toBe("Off");
		expect(share.link).toBeNull();
	});

	async function hostShare(): Promise<RequestFrame[]> {
		const refreshed = await host.client.request(next(), "RefreshShare");
		return refreshed.frames;
	}
});
