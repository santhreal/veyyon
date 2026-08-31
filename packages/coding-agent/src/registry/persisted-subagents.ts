/**
 * Seed the agent registry with the subagents of previous runs.
 *
 * The registry only knows agents this PROCESS started. Restart veyyon, or come
 * back to a session tomorrow, and every subagent it spawned is gone from it
 * while its transcript is still on disk. This walks the session directory tree
 * and registers each one as `parked`: revivable, readable, and visible in the
 * live roster instead of silently absent.
 *
 * It lived inside one of the four agent overlays, which is why the roster and the
 * registry disagreed about what existed depending on which screen you opened.
 * It is a registry concern, so it lives with the registry and any surface can
 * call it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { advisorTranscriptSlug, isSessionFileName, SESSION_BACKUP_EXTENSION } from "@veyyon/utils/session-file";
import { isAdvisorTranscriptName } from "../advisor";
import { type AgentRegistry, MAIN_AGENT_ID } from "./agent-registry";

/**
 * Register every persisted subagent under `sessionFile`'s own directory, and
 * report how many were added.
 *
 * A session file `…/<id>.jsonl` owns the directory `…/<id>/`, which holds its
 * subagents' session files, recursively. Never throws: a tree that cannot be
 * read leaves the roster with whatever the process itself knows, and says so in
 * the log rather than taking down the screen that called it.
 *
 * `scope` is the conversation these transcripts belong to, and every ref is
 * registered with it EXPLICITLY rather than inheriting it through `parentId`.
 * Inheritance cannot do the job here: the parent chain is seeded from the
 * driving agent of `scope`, whose id differs per host and per conversation — an
 * ACP root registers as `acp:<sessionId>`, an interactive session as
 * `main:<sessionId>`, an SDK host names its own — and a conversation whose
 * driving agent is not registered at all has no ref to inherit from, so every
 * seeded agent landed with an UNDEFINED scope. An undefined scope is
 * deliberately visible to everyone, so one
 * conversation opening its Control Center published its whole on-disk subagent
 * tree into every other conversation's roster in the same process.
 *
 * The COUNT is what a caller repaints on. A session with no subagents on disk,
 * or none this process did not already know about, changes nothing, and a
 * screen that refreshed and repainted anyway did a full roster rebuild on every
 * open to display the same rows it had already drawn.
 */
export async function registerPersistedSubagents(
	registry: AgentRegistry,
	sessionFile: string | null | undefined,
	scope?: string,
): Promise<number> {
	if (!sessionFile || !isSessionFileName(sessionFile)) return 0;
	const root = sessionFile.slice(0, -6);
	try {
		// The driving agent of this conversation owns every subagent seeded from
		// its directory. Resolved by role rather than assumed to answer to one
		// name, so a process holding two conversations seeds each tree under its
		// real owner instead of piling both under a single shared parent.
		const owner = registry.mainInScope(scope)?.id ?? MAIN_AGENT_ID;
		return await registerPersistedSubagentsFromDir(registry, root, owner, scope);
	} catch (error) {
		logger.warn("Failed to register persisted subagents", { error });
		return 0;
	}
}

/**
 * When a transcript was started and last written, for the ref restored from it.
 *
 * The file's own times, because they are the only record of the agent's history
 * that survives the process that ran it: the roster prints this as the row's age
 * and the close budget counts from it. An unreadable stat falls back to now,
 * which is the pre-existing behaviour and keeps a scan working on a filesystem
 * that reports no times rather than dropping the agent from the roster.
 *
 * `birthtimeMs` is 0 on filesystems that do not record a creation time, so the
 * write time stands in for it there: an ordering key that reads 1970 sorts every
 * restored agent below every live one, which is not what the roster means by
 * oldest. A creation stamp LATER than the last write is not the agent's either —
 * that is what a copied profile, a restored backup or an rsync without `--times`
 * looks like, a fresh birthtime over a preserved mtime — so the earlier of the
 * two is taken and a transcript can never claim to have been written before it
 * existed.
 */
async function transcriptTimes(sessionFile: string): Promise<{ createdAt: number; lastActivity: number }> {
	try {
		const stat = await fs.promises.stat(sessionFile);
		const lastActivity = stat.mtimeMs;
		const createdAt = stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, lastActivity) : lastActivity;
		return { createdAt, lastActivity };
	} catch {
		const now = Date.now();
		return { createdAt: now, lastActivity: now };
	}
}

async function registerPersistedSubagentsFromDir(
	registry: AgentRegistry,
	dir: string,
	parentId: string | undefined,
	scope: string | undefined,
): Promise<number> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let registered = 0;
	for (const entry of entries) {
		if (!entry.isFile() || !isSessionFileName(entry.name) || entry.name.includes(SESSION_BACKUP_EXTENSION)) continue;
		const sessionFile = path.join(dir, entry.name);
		// The advisor transcript is observability-only: register it as a non-peer
		// `advisor` kind under its owning session so its read-only transcript can be
		// opened, but it never joins agent-facing rosters and is not revivable.
		if (isAdvisorTranscriptName(entry.name)) {
			const owner = parentId ?? MAIN_AGENT_ID;
			// `__advisor.jsonl` → the default advisor (no slug); `__advisor.<slug>.jsonl`
			// → a named advisor, keyed and labeled by its slug.
			const slug = advisorTranscriptSlug(entry.name);
			const advisorId = slug ? `${owner}/advisor:${slug}` : `${owner}/advisor`;
			const displayName = slug ? `advisor:${slug}` : "advisor";
			const existing = registry.get(advisorId);
			// Never clobber a non-advisor ref that happens to share this id (a freak
			// user task literally named `<owner>/advisor`): leave it, skip the advisor.
			if (existing && existing.kind !== "advisor") continue;
			if (existing?.sessionFile !== sessionFile) {
				// The id is reused across `/new`; refresh it to the current session's file.
				if (existing) registry.unregister(advisorId);
				const wrote = await transcriptTimes(sessionFile);
				registry.register({
					id: advisorId,
					displayName,
					kind: "advisor",
					parentId: owner,
					session: null,
					sessionFile,
					status: "parked",
					scope,
					createdAt: wrote.createdAt,
					lastActivity: wrote.lastActivity,
				});
				registered += 1;
			}
			continue;
		}
		const id = entry.name.slice(0, -6);
		if (!registry.get(id)) {
			const wrote = await transcriptTimes(sessionFile);
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: parentId ?? MAIN_AGENT_ID,
				session: null,
				sessionFile,
				status: "parked",
				scope,
				createdAt: wrote.createdAt,
				lastActivity: wrote.lastActivity,
			});
			registered += 1;
		}
		registered += await registerPersistedSubagentsFromDir(registry, path.join(dir, id), id, scope);
	}
	return registered;
}
