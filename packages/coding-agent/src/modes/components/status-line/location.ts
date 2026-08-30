/**
 * Where you are, as the status row shows it.
 *
 * One owner, two callers. The live row reaches it through `pathSegment` in
 * `segments.ts`; the launch card reaches it directly, because the card paints
 * a composer for the first second of the process and the row under that
 * composer used to stay empty until the session mounted. Rendering both
 * through this module is what makes the handover invisible: the text the card
 * puts on the row is the text the live row keeps there.
 *
 * Nothing here reads a session, a model or a context window. Those are the
 * parts of the row that genuinely do not exist yet at launch, and they arrive
 * to the right of what this renders.
 */

import * as os from "node:os";
import * as path from "node:path";
import { sliceWithWidth, visibleWidth } from "@veyyon/tui";
import { pathIsWithin, relativePathWithinRoot } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";
import { settingsOrNull } from "../../../config/settings-instance";
import { shortenPath } from "../../../tools/shorten-path";
import { sanitizeStatusText } from "../../sanitize-status-text";
import { withIcon } from "../../theme/icon-label";
import { theme } from "../../theme/theme";
import { getPreset } from "./presets";
import type { StatusLineSegmentOptions } from "./types";

/** How the path is abbreviated, clamped and rooted. */
export type LocationPathOptions = NonNullable<StatusLineSegmentOptions["path"]>;

/** A linked git worktree, named the way the row collapses it. */
export interface LocationWorktree {
	projectName: string;
	worktreeName: string;
}

export interface LocationInput {
	/** The directory the row is describing. */
	projectDir: string;
	/** Set when `projectDir` is a linked worktree rather than an ordinary checkout. */
	worktree?: LocationWorktree | null;
	/** The current branch, used only to decide whether a worktree dir is worth naming twice. */
	branch?: string | null;
	/** `↳ <path>` tail naming the repository inside a multi-repo workspace. */
	activeRepoRelativeRoot?: string | null;
	options?: LocationPathOptions;
}

/** The rendered path, and the cells a front clip must step over to keep the icon. */
export interface RenderedLocation {
	content: string;
	pin: number;
}

/**
 * The cells `withIcon` spends on the glyph and the space after it, which is what a front clip
 * has to step over to keep the icon. Zero for the symbol presets whose icons are empty --
 * there is nothing to keep and nothing to step over.
 */
function iconPin(icon: string): number {
	return icon ? visibleWidth(icon) + 1 : 0;
}

/**
 * Clip a path to `maxLen` cells, keeping its tail.
 *
 * A clipped path carries exactly one ellipsis, at the front, and reads as a
 * suffix of the real path.
 *
 * CELLS, not UTF-16 units. `maxLen` is compared against the columns the row will
 * spend, so a path holding wide characters -- a CJK directory name, an emoji in a
 * project folder -- was clamped at roughly half the width it then painted, and
 * `String.prototype.slice` could cut a surrogate pair or a grapheme cluster in
 * half and hand the row a lone code unit to render.
 */
export function clampPathLength(pwd: string, maxLen: number): string {
	const total = visibleWidth(pwd);
	if (total <= maxLen) return pwd;
	const ellipsis = "…";
	const room = Math.max(0, maxLen - visibleWidth(ellipsis));
	if (room === 0) return ellipsis;
	return `${ellipsis}${sliceWithWidth(pwd, total - room, room, true).text}`;
}

/**
 * Workspace roots the path segment shows a project RELATIVE to, when no root is configured.
 *
 * Two conventions, and that is all they are: a `Projects` directory in the home directory, and
 * a `/work` mount. They are the default because they are what this segment has always
 * stripped, not because they are anyone's layout -- `path.displayRoots` is how a session names
 * its own, and `/work` on Windows resolves against whichever drive the process is on, which is
 * an accident of `path.resolve` rather than a place anything lives.
 *
 * READ WHEN USED, NOT AT IMPORT. As a module const this joined the home directory once, at the
 * moment the module loaded, and a home resolved after that -- a different `HOME` in a worker, a
 * test that answers `os.homedir()` for a fixture -- never matched a default root again, so the
 * whole default silently stopped stripping. `os.homedir()` reads an environment variable; a
 * render can afford it.
 */
export function defaultDisplayRoots(): readonly string[] {
	return [path.join(os.homedir(), "Projects"), "/work"];
}

/** Display roots already reported as unusable, so a bad entry is named once and not per frame. */
const warnedDisplayRoots = new Set<string>();

/**
 * Expand `~` and reject a root that cannot contain anything.
 *
 * A relative or empty entry never matches a working directory, so left alone it would be a
 * setting that reads as applied and does nothing. It is dropped and named instead. Named to the
 * log rather than thrown: this runs inside a render, and a status line that raises takes the
 * composer down over a typo in a display preference.
 *
 * Both separators are accepted after the tilde. A Windows config is written with the separator
 * that platform uses, and `~\code` silently falling through as a relative entry would be the
 * same setting-that-does-nothing this rejects loudly.
 */
export function resolveDisplayRoots(roots: readonly string[]): string[] {
	const resolved: string[] = [];
	for (const root of roots) {
		const trimmed = typeof root === "string" ? root.trim() : "";
		const afterTilde = trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? trimmed.slice(2) : null;
		const expanded =
			trimmed === "~" ? os.homedir() : afterTilde === null ? trimmed : path.join(os.homedir(), afterTilde);
		if (expanded !== "" && path.isAbsolute(expanded)) {
			resolved.push(expanded);
			continue;
		}
		if (warnedDisplayRoots.has(trimmed)) continue;
		warnedDisplayRoots.add(trimmed);
		logger.warn("Status line path display root ignored: not an absolute path", { root });
	}
	return resolved;
}

/**
 * One slot, because the row re-renders on every keystroke and every animation frame while the
 * working directory changes a handful of times a session. Each root costs a `realpath` inside
 * `relativePathWithinRoot`, so an uncached list of four roots is four syscalls a frame.
 */
let displayRootCache: { pwd: string; key: string; result: string } | null = null;

function stripDisplayRoot(pwd: string, roots: readonly string[] | undefined): string {
	const declared = roots ?? defaultDisplayRoots();
	const key = declared.join("\u0000");
	if (displayRootCache?.pwd === pwd && displayRootCache.key === key) return displayRootCache.result;
	let result = pwd;
	for (const root of resolveDisplayRoots(declared)) {
		const relative = relativePathWithinRoot(root, pwd);
		if (relative) {
			result = relative;
			break;
		}
	}
	displayRootCache = { pwd, key, result };
	return result;
}

/**
 * Directories a project is shown relative to with the scratch icon instead of a display root.
 *
 * Read when used, for the reason {@link defaultDisplayRoots} states: `os.tmpdir()` and the home
 * directory both come from the environment, and a list built at import time answers for the
 * environment the process started in rather than the one it is rendering.
 */
function scratchRoots(): readonly string[] {
	const roots = new Set<string>([os.tmpdir(), path.join(os.homedir(), "tmp")]);
	if (process.platform === "win32") {
		const { TEMP, TMP, SystemRoot } = process.env;
		if (TEMP) roots.add(TEMP);
		if (TMP) roots.add(TMP);
		if (SystemRoot) roots.add(path.join(SystemRoot, "Temp"));
	} else {
		roots.add("/tmp");
		roots.add("/var/tmp");
		if (process.platform === "darwin") {
			roots.add("/private/tmp");
			roots.add("/private/var/tmp");
		}
	}
	return [...roots];
}

export function classifyProjectDir(pwd: string): { scratch: boolean; relative: string | null } {
	for (const root of scratchRoots()) {
		if (pathIsWithin(root, pwd)) {
			return { scratch: true, relative: relativePathWithinRoot(root, pwd) };
		}
	}
	return { scratch: false, relative: null };
}

/** Cells the path is clipped to when the caller states no limit of its own. */
const DEFAULT_PATH_MAX_LENGTH = 40;

/**
 * The path options the live row will render with, resolved from the same two
 * places its own merge reads: the preset's entry, then the session's
 * `statusLine.segmentOptions` override on top.
 *
 * The launch card has no status-line component to ask, and a card that clipped
 * the path at a different budget would move the text sideways the moment the
 * session mounted. Resolved here rather than in the card so the preset table
 * stays the one source of the budget.
 *
 * The card is also the one caller that can run BEFORE the settings store
 * exists — it paints the frame the terminal is owed and startup fills the
 * store behind it — so an absent store resolves to the default preset rather
 * than throwing. Reading through the throwing proxy here would make the first
 * frame depend on initialisation order it was written to be independent of.
 */
export function resolveLocationOptions(): LocationPathOptions {
	const store = settingsOrNull();
	const preset = getPreset(store?.get("statusLine.preset"));
	const fromPreset = preset.segmentOptions?.path ?? {};
	const override = (store?.get("statusLine.segmentOptions") as StatusLineSegmentOptions | undefined)?.path ?? {};
	return { ...fromPreset, ...override };
}

/**
 * The location as the row paints it: an icon, then the working directory
 * stripped of whatever prefix the caller declared and clipped to its budget.
 */
export function renderLocation(input: LocationInput): RenderedLocation {
	const opts = input.options ?? {};
	const stripPrefix = opts.stripWorkPrefix !== false;

	// Linked git worktree: the on-disk path nests the worktree base, the
	// project, and a worktree dir that usually duplicates the branch (already
	// shown by the git segment). Collapse to the project name, appending the
	// worktree dir only when it diverges from the branch.
	if (stripPrefix && input.worktree) {
		const { projectName, worktreeName } = input.worktree;
		const label = input.branch === worktreeName ? projectName : `${projectName}/${worktreeName}`;
		const content = withIcon(
			theme.icon.worktree,
			clampPathLength(sanitizeStatusText(label), opts.maxLength ?? DEFAULT_PATH_MAX_LENGTH),
		);
		return { content: theme.fg("statusLinePath", content), pin: iconPin(theme.icon.worktree) };
	}

	const { scratch, relative } = classifyProjectDir(input.projectDir);
	let pwd = input.projectDir;

	if (stripPrefix) {
		if (scratch) {
			if (relative) pwd = relative;
		} else {
			pwd = stripDisplayRoot(pwd, opts.displayRoots);
		}
	}
	const repoSuffix = input.activeRepoRelativeRoot ? ` ↳ ${sanitizeStatusText(input.activeRepoRelativeRoot)}` : "";
	if (opts.abbreviate !== false) {
		pwd = shortenPath(pwd);
	}

	// A directory name is arbitrary bytes on every platform veyyon runs on except Windows: a
	// tab opens a hole the width arithmetic cannot see, a CR rewinds the row over itself, a
	// BEL rings on every repaint, and an ESC in a directory name is an escape sequence this
	// row would hand the terminal. Sanitized BEFORE the clamp, so the budget is measured on
	// the cells that reach the screen. The same treatment the PR title and the account label
	// already get; the path and the branch were reading straight from the filesystem.
	pwd = clampPathLength(sanitizeStatusText(pwd), opts.maxLength ?? DEFAULT_PATH_MAX_LENGTH);
	if (repoSuffix) {
		pwd = `${pwd}${repoSuffix}`;
	}

	const showScratchIcon = scratch && stripPrefix;
	const icon = showScratchIcon ? theme.icon.scratchFolder : theme.icon.folder;
	return { content: theme.fg("statusLinePath", withIcon(icon, pwd)), pin: iconPin(icon) };
}
