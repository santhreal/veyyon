/**
 * WHY THIS SUITE EXISTS
 *
 * `/collab` reached nothing on the desktop window: the session it drives could
 * not be put in front of anybody. The three actions added for it each cross the
 * same seam --- a `CollabHost` built against an interface rather than against
 * terminal chrome --- so a projection that looked right in one phase and lied in
 * another would draw a card nobody could act on: a link that is null while
 * hosting, a phase that says `off` while the relay still holds the room, a
 * read-only share that hands out a link anybody may prompt through.
 *
 * It drives the real host server over a real socket against an in-memory relay,
 * so what is asserted is the bytes a window would decode.
 *
 * THE CLASS THIS CLOSES. Every phase the share can be in is reached here and
 * read back through `RefreshShare`, so a transition that publishes a stale
 * section, or none, fails. A relay that is not configured is covered because it
 * is the state a fresh install is in, and the one where a control that cannot
 * work must not be offered.
 *
 * WHAT IT DOES NOT CATCH. What the window DRAWS for any of it: that is the
 * surface crate's own suites and the recorded take. It also says nothing about
 * a guest's replica, which is not something this host serves.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GuiHostServer, startGuiHostServer } from "../../src/gui-host";
import type { ShareView } from "../../src/gui-host/wire";
import { installInMemoryRelay, uninstallInMemoryRelay } from "../collab/helpers/in-memory-relay";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { snapshotSections, TestSocketClient } from "./test-client";

describe("a share session can be started, refreshed, and stopped from the desktop", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-share-test-"));
		const authStorage = await isolatedAuthStorage(tempDir);
		installInMemoryRelay();

		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});

		client = await TestSocketClient.connect(server.endpoint);
		// Consume greeting and initial capabilities frames
		await client.nextFrame();
		await client.nextFrame();
	});

	afterEach(async () => {
		uninstallInMemoryRelay();
		client?.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("RefreshShare returns state: 'off' initially", async () => {
		const { frames } = await client.request(1, "RefreshShare");
		const shares = snapshotSections<ShareView>(frames, "Share");
		expect(shares.length).toBeGreaterThan(0);
		const share = shares[shares.length - 1];
		expect(share.state).toBe("off");
		expect(share.link).toBeNull();
		expect(share.participants).toEqual([]);
	});

	test("a relay configured without a scheme is shown as the URL that will be dialled", async () => {
		// A relay is configured as a bare host at least as often as a full URL.
		// The card stating `relay.example.com` while the dial goes to
		// `wss://relay.example.com` is how a link reads as a relay outage.
		await client.request(2, { SetSetting: { key: "collab.relayUrl", value: "relay.example.com:8443" } });
		const { frames } = await client.request(3, "RefreshShare");
		const shares = snapshotSections<ShareView>(frames, "Share");
		expect(shares[shares.length - 1].relay_url).toBe("wss://relay.example.com:8443");
	});

	test("StartShare fails when collab.relayUrl is not configured", async () => {
		// Explicitly clear collab.relayUrl
		await client.request(2, { SetSetting: { key: "collab.relayUrl", value: "" } });

		const { outcome } = await client.request(3, { StartShare: { read_only: false } });
		const error = outcome.RequestFailed?.error;
		expect(error).toBeDefined();
		expect(error?.code).toBe("RELAY_NOT_CONFIGURED");
		expect(error?.message).toContain("collab.relayUrl");
	});

	test("StartShare transitions to hosting and provides links and participants", async () => {
		// Set collab.relayUrl in settings to in-memory relay
		await client.request(4, { SetSetting: { key: "collab.relayUrl", value: "ws://localhost:8788" } });
		const { frames } = await client.request(5, { StartShare: { read_only: false } });
		const shares = snapshotSections<ShareView>(frames, "Share");
		expect(shares.length).toBeGreaterThan(0);
		const share = shares[shares.length - 1];

		expect(share.state).toBe("hosting");
		expect(share.relay_url).toBe("ws://localhost:8788");
		expect(share.link).toContain("ws://localhost:8788");
		expect(share.view_link).toContain("ws://localhost:8788");
		expect(share.participants.length).toBe(1);
		expect(share.participants[0].is_host).toBe(true);
		expect(share.participants[0].can_write).toBe(true);

		// RefreshShare returns the current hosting state
		const refresh = await client.request(6, "RefreshShare");
		const refreshShares = snapshotSections<ShareView>(refresh.frames, "Share");
		expect(refreshShares.length).toBeGreaterThan(0);
		const refreshShare = refreshShares[refreshShares.length - 1];
		expect(refreshShare.state).toBe("hosting");
		expect(refreshShare.link).toBe(share.link);

		// StopShare stops hosting
		const stop = await client.request(7, "StopShare");
		const stopShares = snapshotSections<ShareView>(stop.frames, "Share");
		expect(stopShares.length).toBeGreaterThan(0);
		const stopShare = stopShares[stopShares.length - 1];
		expect(stopShare.state).toBe("off");
		expect(stopShare.link).toBeNull();
	});

	test("StartShare with read_only: true omits writable links", async () => {
		await client.request(8, { SetSetting: { key: "collab.relayUrl", value: "ws://localhost:8788" } });

		const { frames } = await client.request(9, { StartShare: { read_only: true } });
		const shares = snapshotSections<ShareView>(frames, "Share");
		expect(shares.length).toBeGreaterThan(0);
		const share = shares[shares.length - 1];

		expect(share.state).toBe("hosting");
		expect(share.link).toBeNull();
		expect(share.web_link).toBeNull();
		expect(share.view_link).toContain("ws://localhost:8788");

		await client.request(10, "StopShare");
	});

	test("a start the relay refuses leaves the session unshared, carrying the reason", async () => {
		// The in-memory relay answers every address, so it is taken away for
		// this one case: the point is a relay that is named and unreachable,
		// which is what a wrong setting or a relay that is down looks like.
		uninstallInMemoryRelay();
		await client.request(11, {
			SetSetting: { key: "collab.relayUrl", value: "ws://127.0.0.1:1/refused" },
		});

		const { outcome } = await client.request(12, { StartShare: { read_only: false } });
		expect(outcome.RequestFailed?.error).toBeDefined();

		const refresh = await client.request(13, "RefreshShare");
		const shares = snapshotSections<ShareView>(refresh.frames, "Share");
		const share = shares[shares.length - 1];
		expect(share.state).toBe("off");
		expect(share.link).toBeNull();
		expect(share.participants).toEqual([]);
		expect(share.error).not.toBeNull();
	});

	test("a start that failed can be started again, rather than being held by the phase it died in", async () => {
		// The pair that makes this reachable: a second start is refused while
		// one is live, so any failure that leaves the phase off `off` takes
		// sharing away from the session for good, with no control to clear it.
		uninstallInMemoryRelay();
		await client.request(20, {
			SetSetting: { key: "collab.relayUrl", value: "ws://127.0.0.1:1/refused" },
		});
		const failed = await client.request(21, { StartShare: { read_only: false } });
		expect(failed.outcome.RequestFailed?.error).toBeDefined();

		installInMemoryRelay();
		await client.request(22, { SetSetting: { key: "collab.relayUrl", value: "ws://localhost:8788" } });
		const retried = await client.request(23, { StartShare: { read_only: false } });

		expect(retried.outcome.RequestFailed).toBeUndefined();
		const shares = snapshotSections<ShareView>(retried.frames, "Share");
		expect(shares[shares.length - 1].state).toBe("hosting");
	});

	test("a second start while one is running is refused rather than replacing it", async () => {
		await client.request(14, { SetSetting: { key: "collab.relayUrl", value: "ws://localhost:8788" } });
		const first = await client.request(15, { StartShare: { read_only: false } });
		const started = snapshotSections<ShareView>(first.frames, "Share");
		const link = started[started.length - 1].link;
		expect(link).not.toBeNull();

		const second = await client.request(16, { StartShare: { read_only: false } });
		expect(second.outcome.RequestFailed?.error).toBeDefined();

		// The link a guest was already given still names the room it named.
		const refresh = await client.request(17, "RefreshShare");
		const shares = snapshotSections<ShareView>(refresh.frames, "Share");
		const share = shares[shares.length - 1];
		expect(share.state).toBe("hosting");
		expect(share.link).toBe(link);

		await client.request(18, "StopShare");
	});

	test("stopping a share nobody started states that it is off, and mints nothing", async () => {
		// The terminal answers `/collab stop` with a status rather than an
		// error, and this host says the same thing in its own vocabulary: the
		// section comes back `off`, carrying no link for a room that was never
		// created.
		const { outcome, frames } = await client.request(19, "StopShare");
		expect(outcome.RequestFailed).toBeUndefined();
		const shares = snapshotSections<ShareView>(frames, "Share");
		const share = shares[shares.length - 1];
		expect(share.state).toBe("off");
		expect(share.link).toBeNull();
		expect(share.participants).toEqual([]);
	});
});
