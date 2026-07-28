/**
 * A machine-level fault reaches THIS session's operator, and stops reaching it when the session ends.
 *
 * WHY THIS SUITE EXISTS. `packages/utils/test/fault-sink.test.ts` proves the sink module: attach, fan
 * out, detach. It cannot prove the WIRING, and the wiring is where both bugs lived. `createAgentSession`
 * attaches a sink that closes over that session's `OperatorNotices`, so two things have to be true for
 * the channel to be worth having, and neither is visible from inside `packages/utils`:
 *
 *   1. A fault raised by a `@veyyon/utils` free function during this session lands in THIS session's
 *      notices. The functions that find these faults have no session handle, which is the whole reason
 *      the sink exists; a type-checking `attachFaultSink` call proves nothing about whether the closure
 *      reaches the surface an operator is looking at.
 *   2. Disposing the session detaches it. The sink outliving its session kept a disposed
 *      `OperatorNotices` reachable and posted later faults into a channel nothing renders, and a
 *      process that opens sessions in sequence leaked one sink per session, forever.
 *
 * The first version of the sink module could not have passed the second point at all: it held a single
 * slot, so "detach on dispose" would have silenced whichever sibling session was still running. That is
 * why the module became a set, and why this suite asserts the count as well as the delivery.
 *
 * Sessions are built the way `test/sdk-session-isolation.test.ts` builds them, with a shared in-memory
 * auth store and an isolated `Settings`, so neither the SQLite open nor the model probe runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { type OperatorNotice, OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import { faultSinkCount, removeSyncWithRetries, reportFault, Snowflake } from "@veyyon/utils";

describe("the fault sink follows the session that installed it", () => {
	const tempDirs: string[] = [];
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedAuthStorage = await AuthStorage.create(":memory:");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
	});

	afterAll(() => {
		sharedAuthStorage.close();
	});

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	/**
	 * A notices channel plus the array its sink writes to.
	 *
	 * A collecting SINK rather than a read of `all()`, because the sink is what an operator's surface
	 * actually is: a notice that is recorded but never handed to a sink is not one they saw. Note that
	 * `OperatorNotices` collapses identical notices per instance, so every case below raises a distinct
	 * text; two instances receiving the SAME text is the point of the two-session case and works,
	 * because the dedup is per channel.
	 */
	function collectingNotices(): { notices: OperatorNotices; shown: OperatorNotice[] } {
		const shown: OperatorNotice[] = [];
		return { notices: new OperatorNotices(notice => shown.push(notice)), shown };
	}

	/** A session in a fresh tree, with the notices channel supplied so the test can read it. */
	async function openSession(notices: OperatorNotices): ReturnType<typeof createAgentSession> {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-fault-sink-sdk-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, `project-${Snowflake.next()}`);
		fs.mkdirSync(cwd, { recursive: true });

		return createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			operatorNotices: notices,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
	}

	/**
	 * The fault a low layer raises arrives in the session's own notices, with source and text intact.
	 *
	 * This is the end the operator sees. `reportFault` is called here the way `fs-optional.ts` calls it
	 * during a directory scan: as a free function, with no session in scope. If the closure in
	 * `createAgentSession` were not attached, or attached to the wrong channel, this is where it shows,
	 * and nothing else in the suite would notice.
	 */
	it("delivers a low-layer fault into the live session's notices", async () => {
		const { notices, shown } = collectingNotices();
		const { session } = await openSession(notices);
		shown.length = 0;

		try {
			reportFault({
				source: "filesystem",
				text: "the agents directory could not be listed",
				context: { dir: "/x" },
			});

			expect(shown.map(notice => [notice.severity, notice.source, notice.text])).toEqual([
				["warning", "filesystem", "the agents directory could not be listed"],
			]);
		} finally {
			await session.dispose();
		}
	});

	/**
	 * Disposing detaches, so a fault raised afterwards reaches nothing.
	 *
	 * Asserted on BOTH the count and the delivery. The count alone would pass if dispose cleared the
	 * whole set rather than its own registration, and the delivery alone would pass if the sink were
	 * still attached but its notices had quietly become a no-op, which is precisely the disposed-channel
	 * state this is here to rule out.
	 */
	it("stops delivering once the session is disposed", async () => {
		const { notices, shown } = collectingNotices();
		const before = faultSinkCount();
		const { session } = await openSession(notices);
		expect(faultSinkCount()).toBe(before + 1);

		await session.dispose();
		expect(faultSinkCount()).toBe(before);

		shown.length = 0;
		reportFault({ source: "filesystem", text: "raised after dispose" });
		expect(shown).toEqual([]);
	});

	/**
	 * TWO LIVE SESSIONS BOTH SEE THE FAULT, and the second opening does not silence the first.
	 *
	 * This is the bug the set replaced the slot for, asserted through the real wiring rather than
	 * through the module's own API. `createAgentSession` attaches as it builds, so with one slot the
	 * second call overwrote the first session's sink and the first operator was told nothing for the
	 * rest of the run, silently. A machine-level fault (an unlistable directory, a vanished mount) is
	 * true for both sessions, which is why cross-posting is the right answer here and not a leak.
	 */
	it("reaches both sessions when two are open at once", async () => {
		const firstChannel = collectingNotices();
		const secondChannel = collectingNotices();
		const { session: first } = await openSession(firstChannel.notices);
		const { session: second } = await openSession(secondChannel.notices);

		try {
			firstChannel.shown.length = 0;
			secondChannel.shown.length = 0;

			reportFault({ source: "filesystem", text: "the mount is gone" });

			expect(firstChannel.shown.map(notice => notice.text)).toEqual(["the mount is gone"]);
			expect(secondChannel.shown.map(notice => notice.text)).toEqual(["the mount is gone"]);
		} finally {
			await first.dispose();
			await second.dispose();
		}
	});

	/**
	 * And one session disposing leaves the other still receiving.
	 *
	 * The half a single slot could not express: a dispose that cleared the slot would have taken the
	 * surviving session's channel down with it, so this is the case that makes detach-on-dispose safe
	 * rather than merely tidy.
	 */
	it("keeps delivering to the surviving session after the other disposes", async () => {
		const closingChannel = collectingNotices();
		const survivingChannel = collectingNotices();
		const { session: closing } = await openSession(closingChannel.notices);
		const { session: surviving } = await openSession(survivingChannel.notices);

		try {
			await closing.dispose();
			closingChannel.shown.length = 0;
			survivingChannel.shown.length = 0;

			reportFault({ source: "filesystem", text: "after the first session closed" });

			expect(closingChannel.shown).toEqual([]);
			expect(survivingChannel.shown.map(notice => notice.text)).toEqual(["after the first session closed"]);
		} finally {
			await surviving.dispose();
		}
	});
});
