/**
 * WHY THIS SUITE EXISTS. The launch card draws the dirty marker and the effort from what the last launch's
 * status row settled on, recorded in the launch-facts file. The row filed both only from its context-gauge
 * render, so a row without a gauge never filed them: the next launch's card drew a dirty branch clean, or
 * the effort the session started at rather than the one the row last printed, until the session mounted and
 * corrected it.
 *
 * THE CLASS this closes: one zone deciding whether another zone's fact reaches the next launch. Every
 * registered segment is swept as a composition, the tree status beside the git zone and the effort on a row
 * of each segment alone, each starting from a recorded value the row then contradicts, so a segment added to
 * the registry is held to the same rule. The tree status is keyed on the project directory, so a row
 * following another repository files nothing there; a scan that answers nothing keeps the last record; a
 * collab guest's row mirrors another session and files neither fact, with or without a gauge.
 *
 * A row redraws and rescans continuously, so a scan that finds the tree the record already states, and a
 * redraw that settles on the effort it already states, write nothing.
 *
 * WHAT IT DOES NOT CATCH: the card drawing the record, and the rules each recorded fact is validated by,
 * which `the-launch-card-states-what-the-last-launch-knew.test.ts` holds.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import { statSync } from "node:fs";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import {
	type LaunchFactsUpdate,
	readLaunchFacts,
	recordLaunchFacts,
	resetLaunchFactsForTest,
} from "@veyyon/coding-agent/config/launch-facts";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import { ALL_SEGMENT_IDS } from "@veyyon/coding-agent/modes/terminal/components/status-line/segments";
import type {
	CollabStatus,
	StatusLineSegmentId,
} from "@veyyon/coding-agent/modes/terminal/components/status-line/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { GitStatusSummary } from "@veyyon/coding-agent/utils/git";
import * as git from "@veyyon/coding-agent/utils/git";
import { getLaunchFactsCachePath } from "@veyyon/utils";
import * as atomicWrite from "@veyyon/utils/atomic-write";
import {
	enterIsolatedConfigRoot,
	type IsolatedConfigRoot,
} from "../../../../../../utils/test/helpers/isolated-config-root";
import { useFixtureCheckout } from "../../../../helpers/fixture-checkout";
import { makeStatusLineProducer } from "../../../../helpers/status-line-session";

const CLEAN: GitStatusSummary = { staged: 0, unstaged: 0, untracked: 0, truncated: false };
const DIRTY: GitStatusSummary = { staged: 0, unstaged: 2, untracked: 1, truncated: false };

/** The default role, and a session on it whose row settles on a rung other than the recorded one. */
const ROLE = "anthropic/claude-sonnet-4";
const SETTLES_LOW = {
	modelId: "claude-sonnet-4",
	modelProvider: "anthropic",
	modelThinking: true,
	thinkingLevel: ThinkingLevel.Low,
};

const GUEST: CollabStatus = {
	role: "guest",
	participantCount: 2,
	stateOverride: { contextUsage: { tokens: 1000, contextWindow: 200_000, percent: 1 } },
};

const checkout = useFixtureCheckout({ branch: "settled-facts-fixture" });

/** The launch-facts file is written under the config root, so every record here lands in a scratch one. */
let isolated: IsolatedConfigRoot;

beforeAll(async () => {
	isolated = enterIsolatedConfigRoot("settled-facts-record", { defaultProfile: true });
	resetLaunchFactsForTest();
	await Settings.init({ inMemory: true });
	settings.setModelRole("default", ROLE);
	await initTheme(false);
});

afterAll(() => {
	resetLaunchFactsForTest();
	resetSettingsForTest();
	isolated.restore();
});

/** What every case finds recorded before its row mounts, unless it keeps the record a previous row left. */
const SEED: LaunchFactsUpdate = { gitStatus: CLEAN, thinking: ThinkingLevel.High };

interface Composition {
	segments: StatusLineSegmentId[];
	cwd: () => string;
	collab: CollabStatus | null;
	/** What `git status` answers; null is a scan that failed. */
	lands: GitStatusSummary | null;
	/** Recorded before the row mounts; null keeps the record as it stands. */
	recorded?: LaunchFactsUpdate | null;
}

/**
 * Mount a row over `cwd` on the recorded facts, land the scan, render again, and return what the record
 * states afterwards. The default-branch and `gh` lookups a PR zone starts never answer, so no subprocess
 * runs and no repaint arrives out of order.
 */
async function recordedAfterRender({ segments, cwd, collab, lands, recorded = SEED }: Composition) {
	if (recorded) await recordLaunchFacts(recorded);
	const scan = Promise.withResolvers<GitStatusSummary | null>();
	const lookups = [
		vi.spyOn(git.status, "summary").mockImplementation(() => scan.promise),
		vi.spyOn(git.branch, "default").mockImplementation(() => Promise.withResolvers<never>().promise),
		vi.spyOn(git.github, "run").mockImplementation(() => Promise.withResolvers<never>().promise),
	];
	const row = new StatusLineComponent(makeStatusLineProducer({ ...SETTLES_LOW, cwd }));
	try {
		row.updateSettings({ preset: "custom", leftSegments: segments, rightSegments: [] });
		row.setCollabStatus(collab);
		row.renderQuietLine(200);
		scan.resolve(lands);
		// The awaiting continuation and the `finally` block that files the scan.
		await Promise.resolve();
		await Promise.resolve();
		row.renderQuietLine(200);
		const { gitStatus, thinking } = readLaunchFacts();
		return { gitStatus, thinking };
	} finally {
		row.dispose();
		for (const lookup of lookups) lookup.mockRestore();
	}
}

const BESIDE_GIT: StatusLineSegmentId[][] = [["git"], ["git", "context_pct"]];

describe("what a row settled on", () => {
	it("is swept over every registered segment", () => {
		// The sweeps below hold for an empty registry too; this is what makes them mean something.
		expect(ALL_SEGMENT_IDS).toContain("git");
		expect(ALL_SEGMENT_IDS).toContain("context_pct");
	});

	it("files the scanned tree status whichever zones sit beside the git zone", async () => {
		const partners: StatusLineSegmentId[][] = [[], ...ALL_SEGMENT_IDS.filter(id => id !== "git").map(id => [id])];
		const stale: string[] = [];
		for (const partner of partners) {
			const segments: StatusLineSegmentId[] = ["git", ...partner];
			const { gitStatus } = await recordedAfterRender({ segments, cwd: checkout.dir, collab: null, lands: DIRTY });
			if (JSON.stringify(gitStatus) !== JSON.stringify(DIRTY)) stale.push(segments.join(" + "));
		}
		expect(stale).toEqual([]);
	});

	it("files the rung it settled on whichever zone the row shows", async () => {
		const stale: string[] = [];
		for (const segment of ALL_SEGMENT_IDS) {
			const { thinking } = await recordedAfterRender({
				segments: [segment],
				cwd: checkout.dir,
				collab: null,
				lands: CLEAN,
			});
			if (thinking !== ThinkingLevel.Low) stale.push(segment);
		}
		expect(stale).toEqual([]);
	});

	it("files no tree status from a row with no git zone", async () => {
		const segments: StatusLineSegmentId[] = ["context_pct", "pr"];
		const { gitStatus } = await recordedAfterRender({ segments, cwd: checkout.dir, collab: null, lands: DIRTY });
		expect(gitStatus).toEqual(CLEAN);
	});

	it("files no tree status under the project when the row follows another repository", async () => {
		const elsewhere = () => `${checkout.dir()}-elsewhere`;
		for (const segments of BESIDE_GIT) {
			const { gitStatus } = await recordedAfterRender({ segments, cwd: elsewhere, collab: null, lands: DIRTY });
			expect(gitStatus).toEqual(CLEAN);
		}
	});

	it("keeps the recorded tree status when the scan answers nothing", async () => {
		for (const segments of BESIDE_GIT) {
			const { gitStatus } = await recordedAfterRender({ segments, cwd: checkout.dir, collab: null, lands: null });
			expect(gitStatus).toEqual(CLEAN);
		}
	});

	it("is not filed by a collab guest's row, with or without a gauge", async () => {
		for (const segments of BESIDE_GIT) {
			const recorded = await recordedAfterRender({ segments, cwd: checkout.dir, collab: GUEST, lands: DIRTY });
			expect(recorded).toEqual({ gitStatus: CLEAN, thinking: ThinkingLevel.High });
		}
	});

	/**
	 * Observed at the file, the way the launch-card suite observes its own write collapse: each write is a
	 * temp file renamed over the target, so a rewrite moves the inode and the modification time. Every
	 * write the recorder starts is awaited before the file is read, so one still in flight is not missed.
	 */
	it("writes nothing when a row settles on the tree and the rung the record states", async () => {
		const write = atomicWrite.atomicWriteJson;
		const writes: Promise<void>[] = [];
		const spy = vi.spyOn(atomicWrite, "atomicWriteJson").mockImplementation((filePath, data, options) => {
			const pending = write(filePath, data, options);
			writes.push(pending);
			return pending;
		});
		try {
			const segments: StatusLineSegmentId[] = ["git", "context_pct"];
			// The first row files what it settles on; the second finds all of it recorded, from a fresh scan.
			await recordedAfterRender({ segments, cwd: checkout.dir, collab: null, lands: { ...DIRTY } });
			await Promise.all(writes);
			const before = statSync(getLaunchFactsCachePath());
			const settled = writes.length;
			// The first row changed both facts, so a write was seen: the count below is not vacuous.
			expect(settled).toBeGreaterThan(0);

			const again = await recordedAfterRender({
				segments,
				cwd: checkout.dir,
				collab: null,
				lands: { ...DIRTY },
				recorded: null,
			});
			await Promise.all(writes);

			expect(again).toEqual({ gitStatus: DIRTY, thinking: ThinkingLevel.Low });
			expect(writes.length).toBe(settled);
			const after = statSync(getLaunchFactsCachePath());
			expect(after.ino).toBe(before.ino);
			expect(after.mtimeMs).toBe(before.mtimeMs);
		} finally {
			spy.mockRestore();
		}
	});
});
