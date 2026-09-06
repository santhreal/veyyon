/**
 * The branch, as the status row shows it.
 *
 * One owner, two callers, for the same reason {@link ../status-line/location}
 * has two: the live row reaches it through `gitSegment` in `segments.ts`, and
 * the launch card reaches it directly so the row under the card is not blank
 * for the second the session takes to mount.
 *
 * The two callers do not know the same amount, and they resolve that by saying
 * the same thing. The branch name comes out of `.git/HEAD` and its ref files,
 * which is a handful of reads; whether the tree is dirty comes out of
 * `git status`, which is a subprocess and is not run on the frame the terminal
 * is owed. Both answer it from what the last launch recorded until the scan
 * lands. That matters more than it sounds: the marker is not a character the
 * row grows, it is a colour the whole segment carries, so a card and a mount
 * that disagree flip the branch between `statusLineGitDirty` and
 * `statusLineGitClean` and back on a tree that never changed.
 */

import { sanitizeStatusText } from "@veyyon/utils/sanitize-status-text";
import { settingsOrNull } from "../../../../config/settings-instance";
import { withIcon } from "../../../../theme/icon-label";
import { theme } from "../../../../theme/theme-binding";
import type { GitStatusSummary } from "../../../../utils/git";
import { resolvePresetSegments } from "./presets";

/**
 * Branch plus one bare dirty marker, styled — or `""` when there is nothing to
 * say.
 *
 * There used to be a second mode here that broke the dirt out into per-kind
 * counts (`*2 +1 ?3`), gated on `compact` plus three `show*` flags the presets
 * all set. Nothing could reach it: the composer footline is the only renderer
 * of any segment and it asks for the compact form unconditionally, so the
 * counts, the flags and the presets' settings for them were configuration over
 * dead code.
 *
 * `.git/HEAD` is read as a file rather than through `git check-ref-format`, so
 * the refname on the row is whatever a checkout put there and is sanitized
 * here.
 */
export function renderBranch(branch: string | null, dirty: boolean): string {
	let content = branch ? withIcon(theme.icon.branch, sanitizeStatusText(branch)) : "";
	if (dirty) content = `${content} ${theme.fg("statusLineDirty", "*")}`;
	if (!content) return "";
	return theme.fg(dirty ? "statusLineGitDirty" : "statusLineGitClean", content);
}

/**
 * Whether the tree counts as dirty on the row.
 *
 * One bit out of three counts, defined beside the renderer that spends it
 * rather than at the call site, because a second caller asks the same
 * question for a different reason: the repaint that follows a `git status`
 * has to know whether the answer moved the row. A lookup that changes a count
 * without crossing this threshold changes no byte on screen and must not cost
 * a frame.
 *
 * `truncated` is not consulted. Cut output makes the counts lower bounds, and
 * a lower bound above zero is dirty.
 */
export function isTreeDirty(status: GitStatusSummary | null): boolean {
	return !!status && (status.staged > 0 || status.unstaged > 0 || status.untracked > 0);
}

/**
 * Whether the branch belongs on the row at all.
 *
 * Two switches turn it off, and the launch card has to honour both or it
 * paints a branch the mounted row then takes away, which is a worse defect
 * than the blank row the card is here to fix: text that vanishes reads as a
 * crash, text that arrives reads as loading.
 *
 * An absent settings store answers from the default preset, which shows the
 * branch. The card can run before the store exists.
 */
export function isBranchOnTheRow(): boolean {
	const store = settingsOrNull();
	if (store?.get("git.enabled") === false) return false;
	const { left, right } = resolvePresetSegments(store?.get("statusLine.preset"), {
		left: store?.get("statusLine.leftSegments"),
		right: store?.get("statusLine.rightSegments"),
	});
	return left.includes("git") || right.includes("git");
}
