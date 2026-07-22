/**
 * Filesystem cwd boundary.
 *
 * A filesystem tool call whose target lies OUTSIDE the session working directory
 * requires explicit permission in every non-yolo approval mode. This closes a
 * real gap: the per-tool approval *tier* (`read` / `write`) auto-approves by tier
 * alone and never inspects the path, so in `ask` / `auto-edit` / `plan` mode a
 * `read /etc/passwd` or `write /etc/cron.d/x` would otherwise run silently. yolo
 * (the `yolo` autonomy level and the `/yolo` bypass) opts out of all permission,
 * so it opts out of this too — that is the intended "yolo bypasses everything"
 * posture. A hard user `deny` and a plan-mode mutation block remain hard denials;
 * this only ever *adds* a prompt, never downgrades a denial.
 *
 * This module is the ONE place that knows which tools touch the filesystem and
 * via which argument, and the ONE place that decides "inside the working
 * directory" (through `isPathWithinCwd`). The `browser` tool is intentionally
 * absent: it is exec-tier, so every non-yolo mode already prompts for it,
 * including `file://` reads. Add a new filesystem tool here (and only here) to
 * bring it under the boundary.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, isEnotdir } from "@veyyon/utils";
import {
	globSearchBase,
	isInternalUrlPath,
	isPathWithinCwd,
	isReadableUrlPath,
	pathTargetsSsh,
	resolveToCwd,
} from "./path-utils";

/**
 * Sentinel: the physical path could not be verified (a component raised an error
 * other than "does not exist yet", e.g. a permission error we cannot see
 * through). The boundary treats this as an escape and prompts — fail closed
 * rather than auto-approve a path we could not resolve.
 */
const UNRESOLVABLE = Symbol("cwd-boundary-unresolvable");

/**
 * The physical (symlink-resolved) location a target would touch.
 *
 * `isPathWithinCwd` is purely lexical, so a target whose spelled path sits inside
 * cwd but traverses a symlink pointing outside would be judged "inside" and
 * auto-approve while physically escaping. This resolves that: it realpaths the
 * NEAREST EXISTING ANCESTOR of `target` (so a not-yet-created write target
 * realpaths its parent dir instead of throwing ENOENT) and re-appends the
 * non-existent tail lexically. A tail component can introduce no new symlink
 * because it does not exist yet, so the resolved ancestor plus the literal tail
 * is the true physical destination.
 *
 * Walks up only on "does not exist" errors (ENOENT/ENOTDIR); any other error
 * (e.g. EACCES on an ancestor we cannot traverse) returns {@link UNRESOLVABLE}
 * so the caller fails closed instead of trusting an under-resolved lexical path.
 */
function physicalPath(target: string): string | typeof UNRESOLVABLE {
	let current = target;
	const tail: string[] = [];
	for (;;) {
		try {
			const real = fs.realpathSync(current);
			return tail.length ? path.join(real, ...[...tail].reverse()) : real;
		} catch (err) {
			if (!isEnoent(err) && !isEnotdir(err)) return UNRESOLVABLE;
			const parent = path.dirname(current);
			if (parent === current) {
				// Reached the filesystem root without resolving anything (pathological):
				// nothing along the path is a symlink, so the lexical form is physical.
				return tail.length ? path.join(current, ...[...tail].reverse()) : current;
			}
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

/**
 * A tool that reads or writes the filesystem by path. Each such tool declares
 * the raw, user-supplied paths a given call would touch. Keeping this on the
 * tool (rather than a name-keyed table here) means each tool owns the knowledge
 * of its own argument shape — how it names the path, unwraps a hashline header,
 * or parses an apply-patch body — and this module owns only the containment
 * policy. A new filesystem tool joins the boundary simply by implementing this.
 */
export interface CwdBoundedTool {
	/**
	 * Raw path strings (pre-resolution, as supplied) this call would read or
	 * write. A selector suffix (`:1-3`, archive/sqlite sub-paths) may be left
	 * attached: it appends to the filename and cannot introduce `../` traversal,
	 * so it never changes whether the base file is inside cwd. A hashline
	 * `[path#TAG]` wrapper, by contrast, MUST be unwrapped by the tool, or
	 * `[/etc/passwd#AB12]` would resolve as a relative name inside cwd and dodge
	 * the boundary. Non-filesystem destinations (URLs, ssh, internal schemes) may
	 * be included; the boundary skips them.
	 */
	filesystemTargets(args: unknown): string[];
}

/** True when `tool` declares filesystem targets, so the cwd boundary applies. */
export function hasFilesystemTargets(tool: unknown): tool is CwdBoundedTool {
	return typeof (tool as { filesystemTargets?: unknown } | null)?.filesystemTargets === "function";
}

/**
 * True when a raw path targets a non-filesystem destination that is gated (or
 * not applicable) elsewhere: an `http(s)://` / `www.` URL fetch, an `ssh://`
 * remote (exec-tier, already prompts), or an internal `local://`-family scheme
 * (session-local, resolved by a handler, not a real cwd-relative file). Those
 * are never subject to the cwd boundary.
 */
function isNonFilesystemTarget(rawPath: string): boolean {
	return isReadableUrlPath(rawPath) || isInternalUrlPath(rawPath) || pathTargetsSsh(rawPath);
}

/**
 * Filesystem targets for a SEARCH tool (`grep` / `glob` / `ast_grep`), which all
 * take a semicolon-delimited `path` of directories/globs to search. A search
 * reads file contents or directory listings under each pattern's base directory,
 * so an out-of-cwd base must be gated the same as a point read (the user policy
 * is that all non-yolo out-of-cwd filesystem access prompts). Each entry reduces
 * to its {@link globSearchBase} — the fixed root the glob descends from — except
 * a non-filesystem entry (URL / ssh / internal scheme), which is passed through
 * verbatim so the boundary skips it. A bare `*.ts` bases at cwd (in-bounds).
 * Shared by all three tools so the split-and-base rule lives in ONE place.
 */
export function searchPathFilesystemTargets(args: unknown): string[] {
	// `grep` documents `path` but its approval also accepts a legacy `paths`
	// (string or array); mirror that breadth so a search cannot under-report.
	const a = args as { path?: unknown; paths?: unknown } | null;
	const raw = a?.path ?? a?.paths;
	const entries: string[] = [];
	if (typeof raw === "string") entries.push(...raw.split(";"));
	else if (Array.isArray(raw)) {
		for (const item of raw) if (typeof item === "string") entries.push(...item.split(";"));
	}
	const targets: string[] = [];
	for (const entry of entries) {
		const trimmed = entry.trim();
		if (trimmed.length === 0) continue;
		targets.push(isNonFilesystemTarget(trimmed) ? trimmed : globSearchBase(trimmed));
	}
	return targets;
}

/**
 * Resolved absolute paths this tool call would read or write that lie OUTSIDE
 * `cwd`. Empty when the tool is not filesystem-backed, `cwd` is unknown, every
 * target is inside cwd, or the target is a non-filesystem destination. A bare
 * root `/` resolves to `cwd` (workspace-root alias) and is therefore in-bounds.
 */
export function cwdEscapingTargets(tool: unknown, args: unknown, cwd: string): string[] {
	if (!cwd || !hasFilesystemTargets(tool)) return [];
	// Resolve the physical cwd once so the symlink check compares like-for-like:
	// if cwd itself lives under a symlink (e.g. macOS /tmp -> /private/tmp), a
	// target under the same real dir must still read as inside. Fall back to the
	// lexical cwd only if cwd itself cannot be resolved.
	const physicalCwd = physicalPath(cwd);
	const cwdBase = physicalCwd === UNRESOLVABLE ? cwd : physicalCwd;
	const escaping: string[] = [];
	for (const rawPath of tool.filesystemTargets(args)) {
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) continue;
		if (isNonFilesystemTarget(rawPath)) continue;
		const resolved = resolveToCwd(rawPath, cwd);
		// Lexically outside cwd already prompts; no filesystem probe needed.
		if (!isPathWithinCwd(resolved, cwd)) {
			escaping.push(resolved);
			continue;
		}
		// Lexically inside: verify a symlink does not physically escape cwd. Only
		// this (auto-approve) branch pays the realpath cost, and only in non-yolo
		// modes, where cwdEscapingTargets is called at all (yolo bypasses it).
		const physical = physicalPath(resolved);
		if (physical === UNRESOLVABLE || !isPathWithinCwd(physical, cwdBase)) {
			escaping.push(resolved);
		}
	}
	return escaping;
}

/**
 * The permission-prompt reason shown when a call escapes the working directory.
 * States the boundary, the cwd, the offending path(s), and the two ways forward
 * (approve once, or switch to yolo to stop being asked).
 */
export function formatCwdBoundaryReason(cwd: string, escapingTargets: readonly string[]): string {
	const targets = escapingTargets.join(", ");
	return (
		`Path is outside the session working directory (${cwd}): ${targets}. ` +
		`Approve to allow filesystem access outside the working directory, ` +
		`or set tools.approvalMode: yolo to allow it without prompting.`
	);
}
