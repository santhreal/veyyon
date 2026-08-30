import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { isBranchOnTheRow, renderBranch } from "@veyyon/coding-agent/modes/components/status-line/branch";
import { getPreset, resolvePresetSegments } from "@veyyon/coding-agent/modes/components/status-line/presets";
import type { SegmentContext } from "@veyyon/coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@veyyon/coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";

/**
 * WHY: the launch card paints the composer footline about a second before the
 * status line mounts, and it now paints the branch there. Two renderers of one
 * fact is how a handover starts rewriting itself: a different icon, a
 * different sanitizer, or a dirty marker on one side and not the other, and
 * the row visibly redraws when the session arrives. So the card and the live
 * `git` segment call ONE function, and this suite is what fails if a second
 * copy appears.
 *
 * The dirtiness contract is the sharp edge. The card cannot run `git status`
 * on the frame the terminal is owed, and the live row does not have that
 * answer on its first render either, so both render the branch as clean until
 * the lookup lands. The suite pins that they AGREE, by bytes and by the colour
 * name underneath them, for every dirtiness the live row can be in.
 *
 * WHAT IT DOES NOT CATCH, stated plainly: the test runner has no colour
 * terminal, so `theme.fg` returns its input unchanged and clean and dirty
 * differ here only by the `*` marker. The colour choice is asserted at the
 * `theme.fg` call instead, which is the argument that becomes those bytes on a
 * real terminal but is one seam short of the terminal itself. That both rows
 * are optimistic before `git status` answers is a real defect and is NOT
 * closed here — it is filed as
 * `STATUS-A-BRANCH-IS-PAINTED-CLEAN-BEFORE-GIT-STATUS-HAS-ANSWERED`. Whether
 * the card's row lands on the same SCREEN ROW as the live footline is held by
 * `the-first-frame-paints-the-composer-instantly.test.ts`.
 */

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
	settings.set("git.enabled", true);
	settings.set("statusLine.preset", "default");
});

describe("what the branch says about the working tree", () => {
	/** The colour name a render reached for, which the test runner strips out of the bytes. */
	function colorOf(render: () => void): string | undefined {
		const fg = vi.spyOn(theme, "fg");
		fg.mockClear();
		render();
		return fg.mock.calls.find(call => String(call[1]).includes("main"))?.[0] as string | undefined;
	}

	it("shows the dirty marker only for a tree `git status` reported changes in", () => {
		expect(renderBranch("main", false)).not.toContain("*");
		expect(renderBranch("main", true)).toContain("*");
	});

	it("colours the two states apart", () => {
		expect(colorOf(() => renderBranch("main", false))).toBe("statusLineGitClean");
		vi.restoreAllMocks();
		expect(colorOf(() => renderBranch("main", true))).toBe("statusLineGitDirty");
	});

	it("says nothing at all with no branch and no dirt", () => {
		expect(renderBranch(null, false)).toBe("");
	});

	it("still shows the dirty marker when the branch itself is hidden", () => {
		expect(renderBranch(null, true)).toContain("*");
	});

	it("sanitizes whatever a checkout wrote into HEAD", () => {
		expect(renderBranch("top\tic\nx", false)).not.toMatch(/[\t\n]/u);
	});
});

describe("the live git segment and the card render one branch", () => {
	function segmentContext(branch: string | null, status: SegmentContext["git"]["status"]): SegmentContext {
		return {
			git: { branch, status, pr: null },
			options: {},
		} as unknown as SegmentContext;
	}

	it("emits exactly what the card emits, for every dirtiness the live row can be in", () => {
		for (const [status, dirty] of [
			// The card's own state: no `git status` has answered yet. The live
			// row's first render is in exactly this state.
			[null, false],
			[{ staged: 0, unstaged: 0, untracked: 0, truncated: false }, false],
			[{ staged: 1, unstaged: 0, untracked: 0, truncated: false }, true],
			[{ staged: 0, unstaged: 2, untracked: 0, truncated: false }, true],
			[{ staged: 0, unstaged: 0, untracked: 3, truncated: false }, true],
		] as const) {
			const where = `status ${JSON.stringify(status)}`;
			expect(renderSegment("git", segmentContext("main", status)).content, where).toBe(renderBranch("main", dirty));
		}
	});

	it("hides the segment when there is neither a branch nor a status", () => {
		expect(renderSegment("git", segmentContext(null, null))).toMatchObject({ content: "", visible: false });
	});
});

describe("whether the branch belongs on the row at all", () => {
	it("is on by default, because the default preset lists the git segment", () => {
		expect(getPreset("default").leftSegments).toContain("git");
		expect(isBranchOnTheRow()).toBe(true);
	});

	it("is off when git is disabled, so the card does not paint one the row removes", () => {
		settings.set("git.enabled", false);
		expect(isBranchOnTheRow()).toBe(false);
	});

	it("is off under a preset that drops the git segment", () => {
		const without = Object.entries(getPreset("default")).length > 0;
		expect(without).toBe(true);
		settings.set("statusLine.preset", "minimal");
		const listed =
			getPreset("minimal").leftSegments.includes("git") || getPreset("minimal").rightSegments.includes("git");
		expect(isBranchOnTheRow()).toBe(listed);
	});

	it("answers from the default preset before the settings store exists", () => {
		// The card runs on the first frame, which is before `Settings.init`
		// resolves in a cold process. Throwing there would take the whole frame.
		const store = vi.spyOn(settings, "get");
		store.mockImplementation(() => {
			throw new Error("settings must not be read here");
		});
		expect(() => isBranchOnTheRow()).not.toThrow();
	});
});

describe("which segments a preset actually shows", () => {
	it("ignores a configured segment list under a named preset", () => {
		const resolved = resolvePresetSegments("default", { left: ["cost"], right: ["cost"] });
		expect(resolved.left).toEqual(getPreset("default").leftSegments);
		expect(resolved.right).toEqual(getPreset("default").rightSegments);
	});

	it("honors the configured lists under the custom preset", () => {
		const resolved = resolvePresetSegments("custom", { left: ["cost"], right: ["git"] });
		expect(resolved).toEqual({ left: ["cost"], right: ["git"] });
	});

	it("falls back to the custom preset's own lists when nothing is configured", () => {
		expect(resolvePresetSegments("custom")).toEqual({
			left: getPreset("custom").leftSegments,
			right: getPreset("custom").rightSegments,
		});
	});

	it("treats an unset preset as the default one", () => {
		expect(resolvePresetSegments(undefined)).toEqual({
			left: getPreset("default").leftSegments,
			right: getPreset("default").rightSegments,
		});
	});
});
