import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@veyyon/utils";

export const PROJECT_TRUST_STORE_VERSION = 1;

export const PROJECT_TRUST_FILE = "project-trust.json";

export type ProjectTrustDecision = "trusted" | "denied";

export interface ProjectTrustRecord {
	decision: ProjectTrustDecision;
	entries: Record<string, string>;
	decidedAt: string;
}

export interface ProjectTrustStore {
	version: number;
	projects: Record<string, ProjectTrustRecord>;
}

export type ProjectTrustVerdict = "trusted" | "untrusted" | "denied" | "changed" | "unknown-file";

export interface ProjectExecutable {
	absolutePath: string;
	relativePath: string;
	hash: string;
}

export async function canonicalProjectRoot(cwd: string): Promise<string> {
	try {
		return await fs.realpath(path.resolve(cwd));
	} catch (err) {
		if (!isEnoent(err)) logger.debug("project trust: realpath failed, using resolved path", { cwd });
		return path.resolve(cwd);
	}
}

export async function hashFile(absolutePath: string): Promise<string | null> {
	try {
		return createHash("sha256")
			.update(await fs.readFile(absolutePath))
			.digest("hex");
	} catch {
		return null;
	}
}

export async function describeProjectExecutable(
	absolutePath: string,
	canonicalRoot: string,
): Promise<ProjectExecutable | null> {
	const resolved = path.resolve(absolutePath);
	const real = await realPathOrSelf(resolved);
	const relative = path.relative(canonicalRoot, real);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
	const hash = await hashFile(real);
	if (hash === null) return null;
	return { absolutePath: resolved, relativePath: relative.split(path.sep).join("/"), hash };
}

export async function realPathOrSelf(target: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch {
		return target;
	}
}
