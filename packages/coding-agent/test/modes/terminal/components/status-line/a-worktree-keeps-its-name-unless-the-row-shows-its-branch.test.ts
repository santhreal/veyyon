/**
 * WHY THIS SUITE EXISTS. In a linked worktree the path zone collapses `<base>/<project>/<worktree>` to
 * the project name and drops the worktree directory when it equals the branch, because the git zone
 * prints that branch. The row filled the branch whenever a PR zone was on, and the path read it whether
 * or not the git zone printed it, so a row with a PR zone and no git zone, or a git zone with
 * `showBranch: false`, showed `monorepo` alone: neither the worktree nor its branch was anywhere on it.
 *
 * THE CLASS this closes: a zone other than the git zone deciding whether the path names the worktree.
 * The invariant is read off the painted row, for the live row and the launch card alike: the worktree's
 * name appears exactly once. Zero is the defect above; two is a path that kept a name the git zone
 * already prints. Every registered segment is swept beside the path, with the branch shown and hidden,
 * so a segment added to the registry is held to the same rule the commit it lands in.
 *
 * WHAT IT DOES NOT CATCH: a row so narrow that the fitter drops the git zone and keeps a path clipped to
 * a few cells, where the worktree name is lost to the clip either way, and a worktree whose directory
 * differs from its branch, which `status-line-path.test.ts` pins at the segment.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { LaunchComposerFoot } from "@veyyon/coding-agent/modes/terminal/components/composer/composer-chrome";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import { ALL_SEGMENT_IDS } from "@veyyon/coding-agent/modes/terminal/components/status-line/segments";
import type { StatusLineSegmentId } from "@veyyon/coding-agent/modes/terminal/components/status-line/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import * as git from "@veyyon/coding-agent/utils/git";
import { getProjectDir, removeSyncWithRetries, setProjectDir, stripAnsi } from "@veyyon/utils";
import { makeStatusLineProducer } from "../../../../helpers/status-line-session";

/** Wide enough that the fitter sheds and clips nothing. */
const ROOM_TO_SPARE = 400;
/** The worktree directory and the branch checked out in it. */
const WORKTREE_NAME = "topic";

let root = "";
let worktree = "";
let originalProjectDir = "";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false);
	root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-worktree-name-"));
	const commonDir = path.join(root, "monorepo", ".git");
	const gitDir = path.join(commonDir, "worktrees", WORKTREE_NAME);
	worktree = path.join(root, WORKTREE_NAME);
	fs.mkdirSync(gitDir, { recursive: true });
	fs.mkdirSync(worktree, { recursive: true });
	fs.writeFileSync(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n");
	fs.writeFileSync(path.join(gitDir, "HEAD"), `ref: refs/heads/${WORKTREE_NAME}\n`);
	fs.writeFileSync(path.join(gitDir, "commondir"), `${path.relative(gitDir, commonDir)}\n`);
	fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${path.relative(worktree, gitDir)}\n`);
	originalProjectDir = getProjectDir();
	// The card reads the project directory and nothing else.
	setProjectDir(worktree);
});

afterAll(() => {
	setProjectDir(originalProjectDir);
	removeSyncWithRetries(root);
	resetSettingsForTest();
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** `git status`, the default-branch lookup and `gh` are the processes the live row would start. */
function stubGitProcesses(): void {
	spyOn(git.status, "summary").mockResolvedValue({ staged: 0, unstaged: 0, untracked: 0, truncated: false });
	spyOn(git.branch, "default").mockResolvedValue("main");
	spyOn(git.github, "run").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "" } as never);
}

interface Composition {
	label: string;
	segments: StatusLineSegmentId[];
	showBranch: boolean;
}

/** The path beside every registered segment, and alone, with the git zone's branch shown and hidden. */
function compositions(): Composition[] {
	const partners: StatusLineSegmentId[][] = [[], ...ALL_SEGMENT_IDS.filter(id => id !== "path").map(id => [id])];
	return partners.flatMap(partner =>
		[true, false].map(showBranch => ({
			label: `path${partner.map(id => ` + ${id}`).join("")}, showBranch ${showBranch}`,
			segments: ["path", ...partner] as StatusLineSegmentId[],
			showBranch,
		})),
	);
}

function liveRow({ segments, showBranch }: Composition): string {
	const row = new StatusLineComponent(makeStatusLineProducer({ cwd: () => worktree }));
	try {
		row.updateSettings({
			preset: "custom",
			leftSegments: segments,
			rightSegments: [],
			segmentOptions: { git: { showBranch } },
		} as never);
		return stripAnsi(row.renderQuietLine(ROOM_TO_SPARE) ?? "");
	} finally {
		row.dispose();
	}
}

function cardRow({ segments, showBranch }: Composition): string {
	settings.set("statusLine.preset", "custom");
	settings.set("statusLine.leftSegments", segments);
	settings.set("statusLine.rightSegments", []);
	settings.set("statusLine.segmentOptions", { git: { showBranch } } as never);
	return stripAnsi(new LaunchComposerFoot(() => "").render(ROOM_TO_SPARE).join("\n"));
}

function occurrences(text: string): number {
	return text.split(WORKTREE_NAME).length - 1;
}

describe("a worktree named after its branch", () => {
	it("is swept beside every registered segment", () => {
		// The sweep below holds for an empty registry too; this is what makes it mean something.
		expect(ALL_SEGMENT_IDS).toContain("git");
		expect(ALL_SEGMENT_IDS).toContain("pr");
		expect(compositions().length).toBe(ALL_SEGMENT_IDS.length * 2);
	});

	it("is named exactly once on the live row, whichever zones sit beside the path", () => {
		stubGitProcesses();
		const wrong = compositions()
			.map(composition => ({ composition: composition.label, count: occurrences(liveRow(composition)) }))
			.filter(entry => entry.count !== 1);
		expect(wrong).toEqual([]);
	});

	it("is named exactly once on the launch card, whichever zones sit beside the path", () => {
		const wrong = compositions()
			.map(composition => ({ composition: composition.label, count: occurrences(cardRow(composition)) }))
			.filter(entry => entry.count !== 1);
		expect(wrong).toEqual([]);
	});

	it("drops the worktree directory from the path when the git zone prints the branch", () => {
		stubGitProcesses();
		const composition: Composition = { label: "path + git", segments: ["path", "git"], showBranch: true };
		for (const row of [liveRow(composition), cardRow(composition)]) {
			expect(row).not.toContain(`monorepo/${WORKTREE_NAME}`);
			expect(row).toContain("monorepo");
		}
	});
});
