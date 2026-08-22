/**
 * Project-executable trust: the decision that lets code a repository carries run at all.
 *
 * THE PROBLEM THIS OWNS. Opening a directory is not consent to execute what is in it. Two
 * surfaces in this product read code out of the working tree and run it before any tool
 * approval can apply — a project extension or hook (`.veyyon/extensions/**`, imported by
 * `extensibility/extensions/loader.ts`, whose top-level and factory code runs immediately) and
 * a project MCP config (`.mcp.json` and friends, which can name a `command` to spawn and can
 * put a `${ENV_VAR}` credential in an HTTP header). Both happen during startup, so `cd` into a
 * clone is the whole exploit: neither the approval rung, nor the working-directory boundary,
 * nor the secret-use boundary has run yet.
 *
 * WHAT A DECISION COVERS, AND WHY IT IS PER FILE. A decision records the exact bytes the
 * operator agreed to run: one sha-256 per project-relative path. A file that changes, a file
 * that appears, and a path that was never in the record are all untrusted, so an approved
 * project cannot become a different program later without asking again. The alternative — one
 * digest over the whole surface — would need every consumer's file set in hand before the
 * first decision, which is impossible when extensions load before MCP configs are read, and
 * would also invalidate an unrelated extension when one file changes.
 *
 * FAIL CLOSED, AND NEVER SILENTLY. `evaluate` answers `untrusted` for anything it has no
 * record of, and this module has no UI and no prompt: it cannot ask, so it cannot be talked
 * into a default of yes. A caller with an interactive terminal asks and then calls
 * {@link ProjectTrust.trust}; a caller without one (print mode, ACP, RPC, a subagent, CI)
 * loads nothing and says which file and which source it refused, because a refusal nobody can
 * see is indistinguishable from a feature that does not work.
 *
 * A DENIAL IS REMEMBERED. `deny` is recorded rather than merely acted on, so a project the
 * operator said no to does not ask again on the next launch, and the refusal notice still
 * names what is being withheld.
 *
 * THE STORE IS PER PROFILE, KEYED BY REAL PATH. `<agentDir>/project-trust.json`. The key is
 * the canonical (symlink-resolved) project root: without that, `/tmp/link-to-evil` and the
 * directory it points at are two keys for one program, and trusting the harmless-looking one
 * would trust the other. A stale schema version is rejected wholesale rather than migrated —
 * a trust record is exactly the kind of persisted shape that must not be half-understood by a
 * newer build.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@veyyon/utils";

/** Bump when the record shape changes. A file at any other version is discarded, not migrated. */
export const PROJECT_TRUST_STORE_VERSION = 1;

/** File name under the agent directory. */
export const PROJECT_TRUST_FILE = "project-trust.json";

/** What the operator decided about one project. */
export type ProjectTrustDecision = "trusted" | "denied";

export interface ProjectTrustRecord {
	decision: ProjectTrustDecision;
	/** Project-relative POSIX path -> sha-256 of the bytes that were approved. */
	entries: Record<string, string>;
	/** ISO timestamp of the decision, for the operator reading the file. */
	decidedAt: string;
}

export interface ProjectTrustStore {
	version: number;
	projects: Record<string, ProjectTrustRecord>;
}

/**
 * Why one file may not run.
 *
 * - `untrusted` — this project has no decision at all.
 * - `denied` — the operator said no to this project.
 * - `changed` — the project is trusted and this file's bytes are not the approved ones.
 * - `unknown-file` — the project is trusted and this path was not part of that decision.
 */
export type ProjectTrustVerdict = "trusted" | "untrusted" | "denied" | "changed" | "unknown-file";

/** One project-scoped executable, as the gate sees it. */
export interface ProjectExecutable {
	/** Absolute path on disk. */
	absolutePath: string;
	/** Path relative to the canonical project root, in POSIX form. */
	relativePath: string;
	/** sha-256 of the file's bytes, hex. */
	hash: string;
}

/** The canonical, symlink-resolved project root, which is what a record is keyed by. */
export async function canonicalProjectRoot(cwd: string): Promise<string> {
	try {
		return await fs.realpath(path.resolve(cwd));
	} catch (err) {
		// A root that cannot be resolved (deleted under us, permission) still needs a stable
		// key, and `resolve` is the same answer `realpath` gives for a path with no symlinks.
		if (!isEnoent(err)) logger.debug("project trust: realpath failed, using resolved path", { cwd });
		return path.resolve(cwd);
	}
}

/** sha-256 of a file's bytes, or null when it cannot be read. */
export async function hashFile(absolutePath: string): Promise<string | null> {
	try {
		return createHash("sha256")
			.update(await fs.readFile(absolutePath))
			.digest("hex");
	} catch {
		return null;
	}
}

/**
 * Describe one candidate executable, or null when it is not readable.
 *
 * A file outside the project root is NOT a project executable: it belongs to the operator's
 * own profile or an installed plugin, which they put there themselves. That distinction is the
 * whole reason this returns null instead of a record — a gate that trusted `~/.veyyon`
 * extensions through this path would ask the operator to approve their own configuration.
 */
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

/**
 * True when `absolutePath` lives inside the canonical project root.
 *
 * Symlink-resolved on both sides, because a symlink inside the project pointing at a file
 * outside it is still project-controlled content, and a project root reached through a symlink
 * must match the paths the gate compares against it.
 */
export async function isInsideProject(absolutePath: string, canonicalRoot: string): Promise<boolean> {
	const real = await realPathOrSelf(path.resolve(absolutePath));
	const relative = path.relative(canonicalRoot, real);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * The trust store for one profile.
 *
 * Loaded once per session and consulted synchronously afterwards, so a gate on a hot startup
 * path costs one read. `load` never throws: an unreadable or malformed store means no project
 * is trusted, which is the safe reading of "I cannot tell".
 */
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

	/** An in-memory store, for callers with no profile directory to write to. */
	static empty(filePath = ""): ProjectTrust {
		return new ProjectTrust(filePath, { version: PROJECT_TRUST_STORE_VERSION, projects: {} });
	}

	/** The decision on record for `canonicalRoot`, or null when there is none. */
	recordFor(canonicalRoot: string): ProjectTrustRecord | null {
		return this.#store.projects[canonicalRoot] ?? null;
	}

	/** Whether this project has been decided at all, which is what a prompt is gated on. */
	isDecided(canonicalRoot: string): boolean {
		return this.recordFor(canonicalRoot) !== null;
	}

	/** Whether one file may run. See {@link ProjectTrustVerdict}. */
	evaluate(canonicalRoot: string, executable: ProjectExecutable): ProjectTrustVerdict {
		const record = this.recordFor(canonicalRoot);
		if (!record) return "untrusted";
		if (record.decision === "denied") return "denied";
		const approved = record.entries[executable.relativePath];
		if (approved === undefined) return "unknown-file";
		return approved === executable.hash ? "trusted" : "changed";
	}

	/**
	 * Record that these exact files may run, merging with anything already approved.
	 *
	 * Merging rather than replacing: MCP configs are read after extensions are loaded, so a
	 * second decision in the same session must not revoke the first. A path already present is
	 * overwritten with the newly approved hash, which is what makes "trust the changed file"
	 * work without a separate revoke step.
	 */
	async trust(canonicalRoot: string, executables: readonly ProjectExecutable[]): Promise<void> {
		const existing = this.recordFor(canonicalRoot);
		const entries = existing?.decision === "trusted" ? { ...existing.entries } : {};
		for (const executable of executables) entries[executable.relativePath] = executable.hash;
		await this.#write(canonicalRoot, { decision: "trusted", entries, decidedAt: new Date().toISOString() });
	}

	/** Record a refusal, so the next launch does not ask again. */
	async deny(canonicalRoot: string): Promise<void> {
		await this.#write(canonicalRoot, { decision: "denied", entries: {}, decidedAt: new Date().toISOString() });
	}

	/** Forget a project's decision entirely, which makes the next launch ask again. */
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
			// Written through a temp file in the same directory: a half-written trust store read by
			// the next launch is a store that trusts nothing, and losing an operator's decision to
			// an interrupted write would train them to answer the prompt without reading it.
			const temp = `${this.filePath}.${process.pid}.tmp`;
			await fs.writeFile(temp, body, { mode: 0o600 });
			await fs.rename(temp, this.filePath);
		} catch (err) {
			logger.warn("project trust: could not persist the decision", {
				path: this.filePath,
				error: err instanceof Error ? err.message : String(err),
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
	if (!isRecordObject(parsed)) return fresh;
	if (parsed.version !== PROJECT_TRUST_STORE_VERSION) {
		// A record written by another version may mean something else by the same fields. The
		// operator is asked again rather than obeyed on a guess.
		logger.warn("project trust: store version is not this build's, trusting nothing", {
			path: filePath,
			found: parsed.version,
			expected: PROJECT_TRUST_STORE_VERSION,
		});
		return fresh;
	}
	const projects = parsed.projects;
	if (!isRecordObject(projects)) return fresh;
	const kept: Record<string, ProjectTrustRecord> = {};
	for (const [root, record] of Object.entries(projects)) {
		const valid = validateRecord(record);
		if (valid) kept[root] = valid;
	}
	return { version: PROJECT_TRUST_STORE_VERSION, projects: kept };
}

/**
 * Accept one stored record, or drop it.
 *
 * Dropped rather than repaired: a record whose entries are not `path -> hex hash` cannot be
 * partially believed, and the failure of a hand-edit must be "you are asked again", never
 * "some of the files you approved are still approved".
 */
function validateRecord(value: unknown): ProjectTrustRecord | null {
	if (!isRecordObject(value)) return null;
	const decision = value.decision;
	if (decision !== "trusted" && decision !== "denied") return null;
	const entries = value.entries;
	if (!isRecordObject(entries)) return null;
	const kept: Record<string, string> = {};
	for (const [relative, hash] of Object.entries(entries)) {
		if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
		kept[relative] = hash;
	}
	const decidedAt = typeof value.decidedAt === "string" ? value.decidedAt : new Date(0).toISOString();
	return { decision, entries: kept, decidedAt };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The sentence an operator reads when project code was withheld.
 *
 * One line per refused file, naming the source surface and the reason, because "extensions did
 * not load" is not actionable and the reader's next move differs per verdict: an untrusted
 * project needs a decision, a changed file needs a look at what changed.
 */
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
