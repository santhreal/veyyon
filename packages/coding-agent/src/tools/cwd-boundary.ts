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
import { isMissingPath } from "@veyyon/utils";
import {
	expandDelimitedPathEntriesSync,
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
			if (!isMissingPath(err)) return UNRESOLVABLE;
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
	filesystemTargets(args: unknown, cwd: string): string[];
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
export function searchPathFilesystemTargets(args: unknown, cwd = process.cwd()): string[] {
	// `grep` documents `path` but its approval also accepts a legacy `paths`
	// (string or array); mirror that breadth so a search cannot under-report.
	if (!args || typeof args !== "object") return [];
	// Selected by VALUE, not by key presence. `"path" in args` is true for a key
	// carrying null (or any non-path value), and keying off presence let such a
	// key suppress `paths` entirely — the under-report this breadth exists to
	// prevent. No shipped tool reads `paths` in its execute path today, so this
	// is the boundary keeping its stated contract rather than a live hole.
	const direct = "path" in args ? args.path : undefined;
	const legacy = "paths" in args ? args.paths : undefined;
	const raw = typeof direct === "string" || Array.isArray(direct) ? direct : legacy;
	const entries: string[] = [];
	if (typeof raw === "string") {
		const sp = raw.split(";");
		for (let si = 0; si < sp.length; si++) entries.push(sp[si]!);
	} else if (Array.isArray(raw)) {
		for (const item of raw)
			if (typeof item === "string") {
				const sp = item.split(";");
				for (let si = 0; si < sp.length; si++) entries.push(sp[si]!);
			}
	}
	if (entries.length === 0) return [];
	const expanded = expandDelimitedPathEntriesSync(entries, cwd);
	const targets: string[] = [];
	for (const entry of expanded) {
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
	for (const rawPath of tool.filesystemTargets(args, cwd)) {
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
			continue;
		}
		// A suffix makes the spelled target a path that does not exist, so the
		// check above resolved the parent directory and re-appended the whole
		// suffixed name as a tail it had proven introduces no symlink. The file
		// the tool then opens is a PREFIX of that string cut at a `:`, and that
		// prefix does exist and can be a symlink out of cwd — `read
		// secret_link:1-10` escaped where `read secret_link` prompted.
		//
		// Every `:` is tried rather than the read tool's selector grammar,
		// because the forms do not share one: `f:1-10` is a line range,
		// `db:users:42` a sqlite row, `zip:dir/f.ts:5-9` an archive member, and
		// a directory may itself carry a colon (`my:dir/link.env:1-10`), which
		// puts the real file after the second one. A prefix that does not exist
		// resolves to itself and stays in bounds, so sweeping costs a walk and
		// reports nothing extra. The scan starts past index 1 so a Windows
		// drive letter is never read as a selector.
		//
		// A prefix cannot be UNRESOLVABLE here: it shares every ancestor with
		// the full string, so an ancestor that fails for any reason other than
		// "does not exist" already failed the check above and never reached
		// this loop. Only containment is left to decide.
		if (!resolved.includes(":")) continue;
		for (let cut = resolved.indexOf(":", 2); cut > 0; cut = resolved.indexOf(":", cut + 1)) {
			const physicalPrefix = physicalPath(resolved.slice(0, cut));
			if (physicalPrefix !== UNRESOLVABLE && !isPathWithinCwd(physicalPrefix, cwdBase)) {
				escaping.push(resolved);
				break;
			}
		}
	}
	return escaping;
}

/**
 * The permission-prompt reason shown when a call escapes the working directory.
 * States the boundary, the cwd, the offending path(s), and the routes that
 * actually clear it.
 *
 * The routes are named precisely because the obvious guesses do not work. This
 * boundary is applied ON TOP of the rung, so raising the rung to `ask-command`
 * or `auto` does NOT lift it, and neither does a per-tool
 * `tools.approval.<tool>: allow`, which the rung consults and the boundary does
 * not. The message used to offer `tools.approvalMode: yolo` as a bare
 * suggestion, which is true but is the largest hammer there is; `set_cwd` is
 * the answer most of the time, because a path you keep reaching for is usually
 * a working directory you have not moved to yet.
 */
export function formatCwdBoundaryReason(cwd: string, escapingTargets: readonly string[]): string {
	const targets = escapingTargets.join(", ");
	return (
		`Path is outside the session working directory (${cwd}): ${targets}. ` +
		`Approve to allow this call, move the session with set_cwd if you will keep working there, ` +
		`or set tools.approvalMode: yolo to stop being asked at all. ` +
		`Raising the rung to ask-command or auto does not lift this boundary.`
	);
}
