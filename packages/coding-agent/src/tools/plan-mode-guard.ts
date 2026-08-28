import * as fs from "node:fs";
import * as path from "node:path";
import { HL_FILE_HASH_LENGTH, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "@veyyon/hashline";
import { type LocalProtocolOptions, resolveLocalRoot, resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { resolveVaultUrlToPath } from "../internal-urls/vault-protocol";
import type { ToolSession } from ".";
import { normalizeLocalScheme, resolveToCwd } from "./path-utils";
import { ToolError } from "./tool-errors";

const VAULT_SCHEME_PREFIX = "vault:";
const LOCAL_SCHEME_PREFIX = "local:";
const HL_TRAILING_TAG_RE = new RegExp(`${HL_FILE_HASH_SEP}[0-9A-Fa-f]{${HL_FILE_HASH_LENGTH}}$`);

function planLocalProtocolOptions(session: ToolSession): LocalProtocolOptions {
	return (
		session.localProtocolOptions ?? {
			getArtifactsDir: () => session.getArtifactsDir?.() ?? null,
			getSessionId: () => session.getSessionId?.() ?? null,
		}
	);
}

function localSandboxRoot(session: ToolSession): string | null {
	try {
		return path.resolve(resolveLocalRoot(planLocalProtocolOptions(session)));
	} catch {
		return null;
	}
}

function isWithinRoot(absolutePath: string, root: string): boolean {
	if (absolutePath === root) return true;
	const sep = `${root}${path.sep}`;
	return absolutePath.startsWith(sep);
}

export function unwrapHashlineHeaderPath(targetPath: string): string {
	const trimmed = targetPath.trimEnd();
	if (
		trimmed.length < HL_FILE_PREFIX.length + HL_FILE_SUFFIX.length ||
		trimmed[0] !== HL_FILE_PREFIX ||
		trimmed[trimmed.length - 1] !== HL_FILE_SUFFIX
	) {
		return targetPath;
	}
	const inner = trimmed.slice(HL_FILE_PREFIX.length, trimmed.length - HL_FILE_SUFFIX.length);
	const tagMatch = HL_TRAILING_TAG_RE.exec(inner);
	const pathPart = tagMatch ? inner.slice(0, tagMatch.index) : inner;
	if (pathPart.length === 0 || pathPart.includes(HL_FILE_HASH_SEP)) return targetPath;
	return pathPart;
}

export function targetsLocalSandbox(session: ToolSession, targetPath: string): boolean {
	const root = localSandboxRoot(session);
	if (!root) return false;
	let resolved: string;
	try {
		resolved = resolvePlanPath(session, targetPath);
	} catch {
		return false;
	}
	if (!path.isAbsolute(resolved)) return false;
	const absolute = path.resolve(resolved);
	if (isWithinRoot(absolute, root)) return true;
	try {
		const realRoot = fs.realpathSync.native(root);
		if (isWithinRoot(absolute, realRoot)) return true;
		const realParent = fs.realpathSync.native(path.dirname(absolute));
		return isWithinRoot(path.join(realParent, path.basename(absolute)), realRoot);
	} catch {
		return false;
	}
}

export function resolvePlanPath(session: ToolSession, targetPath: string): string {
	const unwrapped = unwrapHashlineHeaderPath(targetPath);
	const normalized = normalizeLocalScheme(unwrapped);
	if (normalized.startsWith(LOCAL_SCHEME_PREFIX)) {
		return resolveLocalUrlToPath(normalized, planLocalProtocolOptions(session));
	}

	if (normalized.startsWith(VAULT_SCHEME_PREFIX)) {
		return resolveVaultUrlToPath(normalized);
	}

	return resolveToCwd(normalized, session.cwd);
}

export function enforcePlanModeWrite(
	session: ToolSession,
	targetPath: string,
	options?: { move?: string; op?: "create" | "update" | "delete" },
): void {
	const state = session.getPlanModeState?.();
	if (!state?.enabled) return;

	if (options?.move) {
		throw new ToolError("Plan mode: renaming files is not allowed.");
	}

	if (options?.op === "delete") {
		throw new ToolError("Plan mode: deleting files is not allowed.");
	}

	if (targetsLocalSandbox(session, targetPath)) return;

	throw new ToolError(
		"Plan mode: the working tree is read-only. Write your plan to a local://<slug>-plan.md file instead.",
	);
}
