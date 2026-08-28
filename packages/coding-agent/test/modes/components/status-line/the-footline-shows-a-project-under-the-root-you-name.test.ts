/**
 * WHY THIS SUITE EXISTS. The path segment shortens a working directory by stripping a workspace
 * root off its front, and the roots were two literals in the source: a `Projects` directory in
 * the home directory, and `/work`. Neither is a fact about anything -- `/work` is a mount
 * convention nothing in this product creates, and on Windows it resolves against whichever
 * drive the process happens to be on, so a project on another drive was never shortened and no
 * setting existed to say where the projects are. `path.displayRoots` is that setting.
 *
 * THE CLASS this closes: a display rule whose inputs are typed into the function that applies
 * them. The sweep reads the default list out of the source at run time, so a root added to the
 * defaults is exercised the moment it exists rather than whenever someone remembers.
 *
 * WHAT IT DOES NOT CATCH: whether a root the operator names exists. A root is a prefix test,
 * not a directory read, so a typo that is still absolute shortens nothing and says nothing --
 * only a root that cannot contain a path at all (relative, empty) is named to the log.
 */
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { QuietSegmentBounds } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import {
	defaultDisplayRoots,
	resolveDisplayRoots,
} from "@veyyon/coding-agent/modes/terminal/components/status-line/segments";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import { logger, pathIsWithin, stripAnsi } from "@veyyon/utils";

/** Wide enough that nothing on the row is clipped, so the text asserted is the text produced. */
const ROOM_TO_SPARE = 400;

/** The project below whichever root a case is about, and short enough to never be clipped. */
const PROJECT = path.join("platform-services", "normalizer");

function makeSession(cwd: () => string): AgentSession {
	return {
		messages: [],
		model: { id: "claude-3-7-sonnet", name: "claude-3-7-sonnet", contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 16000, contextWindow: 128000 }),
		state: {
			messages: [],
			model: { id: "claude-3-7-sonnet", name: "claude-3-7-sonnet", contextWindow: 128000 },
		},
		sessionManager: {
			getCwd: cwd,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
				tokensPerSecond: null,
			}),
			getSessionName: () => "display-root-session",
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		isApprovalBypassed: () => false,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

function slotText(line: string, bounds: readonly QuietSegmentBounds[], id: string): string | null {
	const slot = bounds.find(entry => entry.id === id);
	if (!slot) return null;
	return stripAnsi(line).slice(slot.start, slot.end);
}

/** The path the row painted, with the segment's leading icon and padding dropped. */
function paintedPath(cwd: string, options: Record<string, unknown>): string {
	const statusLine = new StatusLineComponent(makeSession(() => cwd));
	statusLine.updateSettings({
		preset: "custom",
		leftSegments: ["path"],
		rightSegments: [],
		// A budget wide enough that the clamp never runs: this suite is about which prefix is
		// removed, and a clamp mark in the answer would hide that.
		segmentOptions: { path: { maxLength: 300, ...options } },
	} as never);
	const line = statusLine.renderQuietLine(ROOM_TO_SPARE);
	if (line === null) throw new Error("the row painted nothing");
	const slot = slotText(line, statusLine.getQuietSegmentBounds(), "path");
	if (slot === null) throw new Error("the row painted no path slot");
	const at = slot.search(/[…~\p{L}\p{N}/\\]/u);
	return (at < 0 ? slot : slot.slice(at)).trimEnd();
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

describe("the footline shows a project under the root you name", () => {
	it("strips every root the defaults declare, when nothing is configured", () => {
		// Swept out of the source: a third default root is covered here on the commit that adds
		// it, and a default that stopped working turns this red without anyone naming it.
		expect(defaultDisplayRoots().length).toBeGreaterThan(0);
		const offenders: { root: string; painted: string }[] = [];
		const shadowed: string[] = [];

		for (const root of defaultDisplayRoots()) {
			// A scratch directory is classified before any display root is consulted, and a test
			// host can put the home directory inside one (the sandbox HOME is under the OS temp
			// dir). Such a root is unreachable here rather than broken; the ordering itself is
			// asserted below, and the guard keeps this from passing with nothing exercised.
			if (pathIsWithin(os.tmpdir(), root)) {
				shadowed.push(root);
				continue;
			}
			const painted = paintedPath(path.join(root, PROJECT), {});
			if (painted !== PROJECT) offenders.push({ root, painted });
		}

		expect(offenders).toEqual([]);
		expect(shadowed.length).toBeLessThan(defaultDisplayRoots().length);
	});

	it("reads the home directory when it strips, so a home resolved after startup still matches", () => {
		// The defaults were a module const once, joined at import time. A home directory that
		// resolves later -- a worker with its own `HOME`, a session whose home is a symlink the
		// process resolves after loading, a test answering for a fixture -- then matched no
		// default root ever again, and the whole default stopped stripping in silence. It cost a
		// pre-existing suite: the symlink-alias case in test/status-line-path.test.ts went red.
		const home = path.join(path.sep, "srv", "another-home");
		const restore = os.homedir;
		const spy = spyOn(os, "homedir").mockReturnValue(home);
		try {
			expect(paintedPath(path.join(home, "Projects", PROJECT), {})).toBe(PROJECT);
		} finally {
			spy.mockRestore();
			expect(os.homedir).toBe(restore);
		}
	});

	it("classifies a scratch directory before it consults a display root", () => {
		// The order two shorteners run in, pinned because the sweep above depends on it: a
		// project in a temp directory reads relative to that temp directory even when a display
		// root would also have matched it.
		const scratch = path.join(os.tmpdir(), "veyyon-scratch-wins", PROJECT);
		expect(paintedPath(scratch, { displayRoots: [os.tmpdir()] })).toBe(path.join("veyyon-scratch-wins", PROJECT));
	});

	it("leaves a project under no declared root alone, so the strip is visible as a difference", () => {
		// The control for every case here: without it a segment that painted the tail of any
		// path whatsoever would satisfy the assertions above.
		const painted = paintedPath(path.join(path.sep, "srv", "elsewhere", PROJECT), {});
		expect(painted).not.toBe(PROJECT);
		expect(painted.endsWith(PROJECT)).toBe(true);
		expect(painted).toContain("srv");
	});

	it("strips a root the session names, and stops stripping the defaults it replaced", () => {
		const named = path.join(path.sep, "srv", "workspaces");
		expect(paintedPath(path.join(named, PROJECT), { displayRoots: [named] })).toBe(PROJECT);
		// A list REPLACES the defaults rather than extending them: a session that says where its
		// projects are has said it, and a leftover `/work` shortening an unrelated path would be
		// the setting half-applied.
		const underADefault = path.join(defaultDisplayRoots()[0] ?? "", PROJECT);
		expect(paintedPath(underADefault, { displayRoots: [named] })).not.toBe(PROJECT);
	});

	it("expands ~ in a named root, and drops a root that cannot contain anything", () => {
		// At the resolver rather than through the row: whether `~/code` shortens a path depends
		// on where the home directory is, and on a host whose home is inside a scratch root
		// (the test sandbox) nothing under it reaches a display root at all. What the setting
		// promises is the expansion, and this is where the expansion happens.
		expect(resolveDisplayRoots(["~"])).toEqual([os.homedir()]);
		expect(resolveDisplayRoots(["~/code"])).toEqual([path.join(os.homedir(), "code")]);
		expect(resolveDisplayRoots(["~\\code"])).toEqual([path.join(os.homedir(), "code")]);
		expect(resolveDisplayRoots(["  ~/code  "])).toEqual([path.join(os.homedir(), "code")]);
		const absolute = path.join(path.sep, "srv", "workspaces");
		expect(resolveDisplayRoots(["relative/dir", "", "   ", "./here", "..", absolute])).toEqual([absolute]);
	});

	it("takes the first root that matches, so a nested root can be named ahead of the one above it", () => {
		const outer = path.join(path.sep, "srv", "workspaces");
		const inner = path.join(outer, "team");
		const cwd = path.join(inner, PROJECT);
		expect(paintedPath(cwd, { displayRoots: [inner, outer] })).toBe(PROJECT);
		expect(paintedPath(cwd, { displayRoots: [outer, inner] })).toBe(path.join("team", PROJECT));
	});

	it("names an unusable root once, and keeps going with the rest of the list", () => {
		// An entry no other case in this file uses, because the complaint is made once per
		// entry for the life of the process -- which is the contract asserted at the end of
		// this case, and the reason a shared spelling would read as a missing warning here.
		const bad = "not-absolute-in-this-case-only";
		const named = path.join(path.sep, "srv", "workspaces");
		const warn = spyOn(logger, "warn");
		const complaints = (): number =>
			warn.mock.calls.filter(call => {
				const detail = call[1];
				return typeof detail === "object" && detail !== null && "root" in detail && detail.root === bad;
			}).length;

		try {
			expect(paintedPath(path.join(named, PROJECT), { displayRoots: [bad, named] })).toBe(PROJECT);
			expect(complaints()).toBe(1);
			// Once per entry, not once per render: this row repaints on every keystroke and every
			// animation frame, and a per-frame complaint fills the log with one typo.
			expect(paintedPath(path.join(named, "another-project"), { displayRoots: [bad, named] })).toBe(
				"another-project",
			);
			expect(complaints()).toBe(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("strips nothing at all while stripWorkPrefix is off, whatever roots are named", () => {
		const named = path.join(path.sep, "srv", "workspaces");
		const cwd = path.join(named, PROJECT);
		const painted = paintedPath(cwd, { displayRoots: [named], stripWorkPrefix: false });
		expect(painted).not.toBe(PROJECT);
		expect(painted).toContain("workspaces");
	});
});
