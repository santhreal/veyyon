/** Filesystem cwd boundary. A filesystem tool call whose target lies OUTSIDE the session working directory */

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

/** Sentinel: the physical path could not be verified (a component raised an error other than "does not exist yet", e.g. a permission error we cannot see */
const UNRESOLVABLE = Symbol("cwd-boundary-unresolvable");

/** The physical (symlink-resolved) location a target would touch. `isPathWithinCwd` is purely lexical, so a target whose spelled path sits inside */
function physicalPath(target: string): string | typeof UNRESOLVABLE {
	let current = target;
	const tail: string[] = [];
	for (;;) {
		try {
			const real = fs.realpathSync(current);
			return tail.length ? path.join(real, ...tail.slice().reverse()) : real;
		} catch (err) {
			if (!isMissingPath(err)) return UNRESOLVABLE;
			const parent = path.dirname(current);
			if (parent === current) {
				// Reached the filesystem root without resolving anything (pathological):
				// nothing along the path is a symlink, so the lexical form is physical.
				return tail.length ? path.join(current, ...tail.slice().reverse()) : current;
			}
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

/** A tool that reads or writes the filesystem by path. Each such tool declares the raw, user-supplied paths a given call would touch. Keeping this on the */
export interface CwdBoundedTool {
	/** Raw path strings (pre-resolution, as supplied) this call would read or write. A selector suffix (`:1-3`, archive/sqlite sub-paths) may be left */
	filesystemTargets(args: unknown, cwd: string): string[];
}

/** True when `tool` declares filesystem targets, so the cwd boundary applies. */
export function hasFilesystemTargets(tool: unknown): tool is CwdBoundedTool {
	return typeof (tool as { filesystemTargets?: unknown } | null)?.filesystemTargets === "function";
}

/** True when a raw path targets a non-filesystem destination that is gated (or not applicable) elsewhere: an `http(s)://` / `www.` URL fetch, an `ssh://` */
function isNonFilesystemTarget(rawPath: string): boolean {
	return isReadableUrlPath(rawPath) || isInternalUrlPath(rawPath) || pathTargetsSsh(rawPath);
}

/** Filesystem targets for a SEARCH tool (`grep` / `glob` / `ast_grep`), which all take a semicolon-delimited `path` of directories/globs to search. A search */
export function searchPathFilesystemTargets(args: unknown, cwd = process.cwd()): string[] {
	// `grep` documents `path` but its approval also accepts a legacy `paths`
	// (string or array); mirror that breadth so a search cannot under-report.
	if (!args || typeof args !== "object") return [];
	// Selected by VALUE, not by key presence. `"path" in args` is true for a key carrying null (or any non-path value), and keying off presence let such a
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

/** Resolved absolute paths this tool call would read or write that lie OUTSIDE `cwd`. Empty when the tool is not filesystem-backed, `cwd` is unknown, every */
export function cwdEscapingTargets(tool: unknown, args: unknown, cwd: string): string[] {
	if (!cwd || !hasFilesystemTargets(tool)) return [];
	// Resolve the physical cwd once so the symlink check compares like-for-like: if cwd itself lives under a symlink (e.g. macOS /tmp -> /private/tmp), a
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
		// A suffix makes the spelled target a path that does not exist, so the check above resolved the parent directory and re-appended the whole
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

/** The permission-prompt reason shown when a call escapes the working directory. States the boundary, the cwd, the offending path(s), and the routes that */
export function formatCwdBoundaryReason(cwd: string, escapingTargets: readonly string[]): string {
	const targets = escapingTargets.join(", ");
	return (
		`Path is outside the session working directory (${cwd}): ${targets}. ` +
		`Approve to allow this call, move the session with set_cwd if you will keep working there, ` +
		`or set tools.approvalMode: yolo to stop being asked at all. ` +
		`Raising the rung to ask-command or auto does not lift this boundary.`
	);
}
