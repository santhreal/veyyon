/**
 * WHY THIS SUITE EXISTS. A project directory that is not a repository but holds exactly one repository
 * (a workspace with `app-backend/` inside it) is described by that child: the path zone names it after
 * a `↳`, and the git zone reads its branch and runs `git status` in it rather than in the workspace.
 * With `git.enabled` off the row does no repository discovery at all, so the same workspace reads as
 * a plain directory and no git process is started for any zone.
 *
 * Every case drives the real `StatusLineComponent` over a real directory tree. `git status` and `gh`
 * are the only seams replaced: the status answer is dirty only for the child repository, so the `*`
 * marker on the row is what proves the lookup ran in the child.
 *
 * THE CLASS this closes: a zone that names or reads a repository resolving it under the wrong
 * condition, whether git off still discovers the child, a path-only row skips discovery, or the git
 * zone reads the workspace instead of the child.
 *
 * WHAT IT DOES NOT CATCH: a linked worktree, whose label is pinned by `status-line-path.test.ts`, and
 * a workspace holding two repositories, which resolves to none and is pinned by
 * `a-location-context-derives-repo-and-worktree-state.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import type { StatusLineSegmentId } from "@veyyon/coding-agent/modes/terminal/components/status-line/types";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import * as git from "@veyyon/coding-agent/utils/git";
import { stripAnsi } from "@veyyon/utils";
import { makeStatusLineProducer } from "../../../../helpers/status-line-session";

/** Wide enough that nothing on the row is clipped or shed. */
const ROOM_TO_SPARE = 400;
const CHILD_BRANCH = "child-branch";

let root: string;
let workspace: string;
let childRepo: string;

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
	root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-row-repository-"));
	workspace = path.join(root, "workspace");
	childRepo = path.join(workspace, "app-backend");
	fs.mkdirSync(path.join(childRepo, ".git"), { recursive: true });
	fs.writeFileSync(path.join(childRepo, ".git", "HEAD"), `ref: refs/heads/${CHILD_BRANCH}\n`, "utf8");
	fs.mkdirSync(path.join(workspace, "notes"), { recursive: true });
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

afterEach(() => {
	vi.restoreAllMocks();
	Settings.instance.override("git.enabled", true);
});

/** `git status` answers dirty in the child repository and clean anywhere else; `gh` finds no PR. */
function stubGitProcesses() {
	const summary = spyOn(git.status, "summary").mockImplementation(async cwd =>
		cwd === childRepo
			? { staged: 0, unstaged: 1, untracked: 0, truncated: false }
			: { staged: 0, unstaged: 0, untracked: 0, truncated: false },
	);
	const gh = spyOn(git.github, "run").mockImplementation(
		async () => ({ exitCode: 1, stdout: "", stderr: "" }) as never,
	);
	return { summary, gh };
}

function mountRow(gitEnabled: boolean, segments: StatusLineSegmentId[]) {
	Settings.instance.override("git.enabled", gitEnabled);
	const row = new StatusLineComponent(makeStatusLineProducer({ cwd: () => workspace }));
	const repaint = Promise.withResolvers<void>();
	row.watchGitState(() => repaint.resolve());
	row.updateSettings({ preset: "custom", leftSegments: segments, rightSegments: [] });
	return { row, repaint: repaint.promise };
}

/** The text of one zone on the row, or null when the row painted no slot for it. */
function zone(row: StatusLineComponent, id: StatusLineSegmentId): string | null {
	const line = row.renderQuietLine(ROOM_TO_SPARE);
	if (line === null) throw new Error("the row painted nothing");
	const slot = row.getQuietSegmentBounds().find(entry => entry.id === id);
	return slot ? stripAnsi(line).slice(slot.start, slot.end).trim() : null;
}

describe("a workspace holding one repository, with git on", () => {
	it("names the repository in the path zone even when no git zone is on the row", () => {
		stubGitProcesses();
		const { row } = mountRow(true, ["path"]);
		try {
			expect(zone(row, "path")).toEndWith("workspace ↳ app-backend");
		} finally {
			row.dispose();
		}
	});

	it("reads the branch and the tree status of the repository, not of the workspace", async () => {
		stubGitProcesses();
		const { row, repaint } = mountRow(true, ["git"]);
		try {
			// The first frame states the branch from the child's HEAD; `git status` has not answered.
			expect(zone(row, "git")).toEndWith(CHILD_BRANCH);
			await repaint;
			expect(zone(row, "git")).toEndWith(`${CHILD_BRANCH} *`);
		} finally {
			row.dispose();
		}
	});
});

describe("the same workspace with git off", () => {
	it("reads as a plain directory and starts no git process for any zone", () => {
		const { summary, gh } = stubGitProcesses();
		const { row } = mountRow(false, ["path", "git", "pr"]);
		try {
			const painted = zone(row, "path");
			expect(painted).toEndWith("workspace");
			expect(painted).not.toContain("app-backend");
			expect(zone(row, "git")).toBeNull();
			expect(zone(row, "pr")).toBeNull();
			expect(summary).not.toHaveBeenCalled();
			expect(gh).not.toHaveBeenCalled();
		} finally {
			row.dispose();
		}
	});
});
