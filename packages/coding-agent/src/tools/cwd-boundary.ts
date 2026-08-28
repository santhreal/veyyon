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

const UNRESOLVABLE = Symbol("cwd-boundary-unresolvable");

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
				return tail.length ? path.join(current, ...tail.slice().reverse()) : current;
			}
			tail.push(path.basename(current));
			current = parent;
		}
	}
}

export interface CwdBoundedTool {
	filesystemTargets(args: unknown, cwd: string): string[];
}

export function hasFilesystemTargets(tool: unknown): tool is CwdBoundedTool {
	return typeof (tool as { filesystemTargets?: unknown } | null)?.filesystemTargets === "function";
}

function isNonFilesystemTarget(rawPath: string): boolean {
	return isReadableUrlPath(rawPath) || isInternalUrlPath(rawPath) || pathTargetsSsh(rawPath);
}

export function searchPathFilesystemTargets(args: unknown, cwd = process.cwd()): string[] {
	if (!args || typeof args !== "object") return [];
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

export function cwdEscapingTargets(tool: unknown, args: unknown, cwd: string): string[] {
	if (!cwd || !hasFilesystemTargets(tool)) return [];
	const physicalCwd = physicalPath(cwd);
	const cwdBase = physicalCwd === UNRESOLVABLE ? cwd : physicalCwd;
	const escaping: string[] = [];
	for (const rawPath of tool.filesystemTargets(args, cwd)) {
		if (typeof rawPath !== "string" || rawPath.trim().length === 0) continue;
		if (isNonFilesystemTarget(rawPath)) continue;
		const resolved = resolveToCwd(rawPath, cwd);
		if (!isPathWithinCwd(resolved, cwd)) {
			escaping.push(resolved);
			continue;
		}
		const physical = physicalPath(resolved);
		if (physical === UNRESOLVABLE || !isPathWithinCwd(physical, cwdBase)) {
			escaping.push(resolved);
			continue;
		}
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

export function formatCwdBoundaryReason(cwd: string, escapingTargets: readonly string[]): string {
	const targets = escapingTargets.join(", ");
	return (
		`Path is outside the session working directory (${cwd}): ${targets}. ` +
		`Approve to allow this call, move the session with set_cwd if you will keep working there, ` +
		`or set tools.approvalMode: yolo to stop being asked at all. ` +
		`Raising the rung to ask-command or auto does not lift this boundary.`
	);
}
