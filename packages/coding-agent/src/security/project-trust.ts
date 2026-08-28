import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, errorMessage, isEnoent, isRecord, logger } from "@veyyon/utils";

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

async function realPathOrSelf(target: string): Promise<string> {
	try {
		return await fs.realpath(target);
	} catch {
		return target;
	}
}

export class ProjectTrust {
	#store: ProjectTrustStore;
	readonly filePath: string;

	private constructor(filePath: string, store: ProjectTrustStore) {
		this.filePath = filePath;
		this.#store = store;
	}

	static async load(agentDir: string): Promise<ProjectTrust> {
		const filePath = path.join(agentDir, PROJECT_TRUST_FILE);
		return new ProjectTrust(filePath, await readStore(filePath));
	}

	static empty(filePath = ""): ProjectTrust {
		return new ProjectTrust(filePath, { version: PROJECT_TRUST_STORE_VERSION, projects: {} });
	}

	recordFor(canonicalRoot: string): ProjectTrustRecord | null {
		return this.#store.projects[canonicalRoot] ?? null;
	}

	isDecided(canonicalRoot: string): boolean {
		return this.recordFor(canonicalRoot) !== null;
	}

	evaluate(canonicalRoot: string, executable: ProjectExecutable): ProjectTrustVerdict {
		const record = this.recordFor(canonicalRoot);
		if (!record) return "untrusted";
		if (record.decision === "denied") return "denied";
		const approved = record.entries[executable.relativePath];
		if (approved === undefined) return "unknown-file";
		return approved === executable.hash ? "trusted" : "changed";
	}

	async trust(canonicalRoot: string, executables: readonly ProjectExecutable[]): Promise<void> {
		const existing = this.recordFor(canonicalRoot);
		const entries = existing?.decision === "trusted" ? { ...existing.entries } : {};
		for (const executable of executables) entries[executable.relativePath] = executable.hash;
		await this.#write(canonicalRoot, { decision: "trusted", entries, decidedAt: new Date().toISOString() });
	}

	async deny(canonicalRoot: string): Promise<void> {
		await this.#write(canonicalRoot, { decision: "denied", entries: {}, decidedAt: new Date().toISOString() });
	}

	async forget(canonicalRoot: string): Promise<void> {
		if (!this.recordFor(canonicalRoot)) return;
		delete this.#store.projects[canonicalRoot];
		await this.#persist();
	}

	async #write(canonicalRoot: string, record: ProjectTrustRecord): Promise<void> {
		this.#store.projects[canonicalRoot] = record;
		await this.#persist();
	}

	async #persist(): Promise<void> {
		if (!this.filePath) return;
		const body = `${JSON.stringify({ version: PROJECT_TRUST_STORE_VERSION, projects: this.#store.projects }, null, 2)}\n`;
		try {
			await fs.mkdir(path.dirname(this.filePath), { recursive: true });
			await atomicWriteFile(this.filePath, body, { mode: 0o600 });
		} catch (err) {
			logger.warn("project trust: could not persist the decision", {
				path: this.filePath,
				error: errorMessage(err),
			});
		}
	}
}

async function readStore(filePath: string): Promise<ProjectTrustStore> {
	const fresh: ProjectTrustStore = { version: PROJECT_TRUST_STORE_VERSION, projects: {} };
	let text: string;
	try {
		text = await fs.readFile(filePath, "utf8");
	} catch (err) {
		if (!isEnoent(err)) {
			logger.warn("project trust: store unreadable, trusting nothing", { path: filePath });
		}
		return fresh;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		logger.warn("project trust: store is not JSON, trusting nothing", { path: filePath });
		return fresh;
	}
	if (!isRecord(parsed)) return fresh;
	if (parsed.version !== PROJECT_TRUST_STORE_VERSION) {
		logger.warn("project trust: store version is not this build's, trusting nothing", {
			path: filePath,
			found: parsed.version,
			expected: PROJECT_TRUST_STORE_VERSION,
		});
		return fresh;
	}
	const projects = parsed.projects;
	if (!isRecord(projects)) return fresh;
	const kept: Record<string, ProjectTrustRecord> = {};
	for (const [root, record] of Object.entries(projects)) {
		const valid = validateRecord(record);
		if (valid) kept[root] = valid;
	}
	return { version: PROJECT_TRUST_STORE_VERSION, projects: kept };
}

function validateRecord(value: unknown): ProjectTrustRecord | null {
	if (!isRecord(value)) return null;
	const decision = value.decision;
	if (decision !== "trusted" && decision !== "denied") return null;
	const entries = value.entries;
	if (!isRecord(entries)) return null;
	const kept: Record<string, string> = {};
	for (const [relative, hash] of Object.entries(entries)) {
		if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
		kept[relative] = hash;
	}
	const decidedAt = typeof value.decidedAt === "string" ? value.decidedAt : new Date(0).toISOString();
	return { decision, entries: kept, decidedAt };
}

export function describeRefusal(source: string, relativePath: string, verdict: ProjectTrustVerdict): string {
	const reason =
		verdict === "denied"
			? "this project is marked untrusted"
			: verdict === "changed"
				? "its contents changed since it was trusted"
				: verdict === "unknown-file"
					? "it was not part of the approved set"
					: "this project has not been trusted";
	return (
		`${source}: ${relativePath} was not loaded because ${reason}. ` +
		`Project code runs with your permissions; approve it with \`/trust approve\` in this session ` +
		`or \`veyyon trust\` in this directory, or leave it untrusted.`
	);
}
