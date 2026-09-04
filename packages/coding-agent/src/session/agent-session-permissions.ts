/**
 * The ACP permission gate's read-only half: which tool calls need the client's consent, what to
 * call the operation on screen, and which files it will touch.
 *
 * Every function here is a pure read of the tool arguments. Asking the client, caching the answer
 * and acting on it stay in `AgentSession`, which owns the connection and the session state.
 */

import { Patch } from "@veyyon/hashline";
import type { ClientBridgePermissionOption } from "@veyyon/kernel/session/client-bridge";
import { getStringProperty, isRecord } from "@veyyon/utils";
import { expandApplyPatchToEntries } from "../edit/modes/apply-patch";
import { TOOL } from "../tools/core/builtin-names";
import { resolveToCwd } from "../tools/core/path-utils";

// The package surface carries this helper from here; its one definition is in `@veyyon/utils`.
export { getStringProperty };

/** Tools that require user permission before execution when an ACP client is connected. */
export const PERMISSION_REQUIRED_TOOLS = new Set([TOOL.bash, TOOL.edit, "delete", "move"]);

/** Permission options presented to the client on each gated tool call. */
export const PERMISSION_OPTIONS: ClientBridgePermissionOption[] = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

export const PERMISSION_OPTIONS_BY_ID = new Map(PERMISSION_OPTIONS.map(option => [option.optionId, option]));

/** What a gated tool call is asking to do, as the client will be shown it. */
export interface PermissionIntent {
	toolName: string;
	title: string;
	paths?: string[];
	cacheKey: string;
}

export function collectStringPaths(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Whether an `edit` call deletes or moves a file, which is what makes it worth a prompt.
 *
 * The edit tool reaches those two operations through three argument shapes: structured `edits`
 * entries, a hashline patch in `input`, and an apply_patch envelope in the same field. All three
 * are read here, because a gate that understands one of them consents to the other two silently.
 */
export function getEditDestructiveIntent(args: unknown): { kind: "delete" | "move"; paths: string[] } | undefined {
	if (!isRecord(args)) return undefined;
	const a = args as Record<string, unknown>;

	const edits = Array.isArray(a.edits) ? a.edits : undefined;
	if (edits) {
		const path = getStringProperty(a, "path");
		if (path) {
			for (const edit of edits) {
				if (!isRecord(edit)) continue;
				const op = getStringProperty(edit as Record<string, unknown>, "op");
				if (op === "delete") return { kind: "delete", paths: [path] };
			}
		}
		for (const edit of edits) {
			if (!isRecord(edit)) continue;
			const entry = edit as Record<string, unknown>;
			const op = getStringProperty(entry, "op");
			const rename = getStringProperty(entry, "rename");
			if (op !== "create" && rename) return { kind: "move", paths: path ? [path, rename] : [rename] };
		}
	}

	const input = getStringProperty(a, "input");
	if (input) {
		try {
			const patch = Patch.parse(input);
			for (const section of patch.sections) {
				if (section.fileOp?.kind === "rem") return { kind: "delete", paths: [section.path] };
				if (section.fileOp?.kind === "move") return { kind: "move", paths: [section.path, section.fileOp.dest] };
			}
		} catch {
			// Not a hashline patch — fall through to apply_patch parsing.
		}
		try {
			const entries = expandApplyPatchToEntries({ input });
			const deleteEntry = entries.find(entry => entry.op === "delete");
			if (deleteEntry) return { kind: "delete", paths: [deleteEntry.path] };
			const moveEntry = entries.find(entry => entry.rename);
			if (moveEntry?.rename) return { kind: "move", paths: [moveEntry.path, moveEntry.rename] };
		} catch {
			// If the edit input is not an apply_patch envelope, it is not a delete/move operation.
		}
	}

	return undefined;
}

/**
 * The prompt a gated tool call earns, or undefined when it needs none.
 *
 * `cacheKey` is what an "always allow" answer is remembered under, so it is coarser than the
 * title: every bash command shares one key, while an edit that deletes is kept apart from an edit
 * that moves.
 */
export function getPermissionIntent(toolName: string, args: unknown): PermissionIntent | undefined {
	const a = isRecord(args) ? (args as Record<string, unknown>) : {};
	if (toolName === TOOL.bash) {
		const cmd = getStringProperty(a, "command")?.slice(0, 80);
		return { toolName, title: cmd || toolName, cacheKey: toolName };
	}
	if (toolName === "delete") {
		const p = getStringProperty(a, "path");
		return { toolName, title: p ? `Delete ${p}` : toolName, paths: p ? [p] : undefined, cacheKey: toolName };
	}
	if (toolName === "move") {
		const from = getStringProperty(a, "oldPath") ?? getStringProperty(a, "path") ?? getStringProperty(a, "from");
		const to = getStringProperty(a, "newPath") ?? getStringProperty(a, "to") ?? getStringProperty(a, "destination");
		if (from && to) return { toolName, title: `Move ${from} to ${to}`, paths: [from, to], cacheKey: toolName };
		return {
			toolName,
			title: from ? `Move ${from}` : toolName,
			paths: from ? [from] : undefined,
			cacheKey: toolName,
		};
	}
	if (toolName === TOOL.edit) {
		const intent = getEditDestructiveIntent(args);
		if (!intent) return undefined;
		if (intent.kind === "delete") {
			return {
				toolName,
				title: `Delete ${intent.paths[0] ?? "edit target"}`,
				paths: intent.paths,
				cacheKey: "edit:delete",
			};
		}
		const from = intent.paths[0];
		const to = intent.paths[1];
		return {
			toolName,
			title: from && to ? `Move ${from} to ${to}` : `Move ${from ?? to ?? "edit target"}`,
			paths: intent.paths,
			cacheKey: "edit:move",
		};
	}
	return undefined;
}

/**
 * The files a gated call touches, as absolute paths the editor host can open.
 *
 * ACP locations are resolved against the session cwd because tool arguments are usually relative
 * and the client cannot resolve them itself. A path that will not resolve is dropped rather than
 * sent, and duplicates are collapsed so one file is not focused twice.
 */
export function extractPermissionLocations(
	args: unknown,
	cwd: string,
	explicitPaths?: string[],
): { path: string; line?: number }[] {
	if (!args || typeof args !== "object") return [];
	const a = args as Record<string, unknown>;
	const out: { path: string; line?: number }[] = [];
	const pushPath = (value: unknown) => {
		if (typeof value !== "string" || value.length === 0) return;
		let resolved: string;
		try {
			resolved = resolveToCwd(value, cwd);
		} catch {
			return;
		}
		if (out.some(location => location.path === resolved)) return;
		out.push({ path: resolved });
	};
	if (explicitPaths) {
		for (const p of explicitPaths) {
			pushPath(p);
		}
		return out;
	}
	pushPath(a.path);
	pushPath(a.file);
	for (const p of collectStringPaths(a.paths)) {
		pushPath(p);
	}
	pushPath(a.oldPath);
	pushPath(a.newPath);
	pushPath(a.from);
	pushPath(a.to);
	pushPath(a.source);
	pushPath(a.destination);
	return out;
}
