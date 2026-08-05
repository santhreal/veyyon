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
 * Inheritance cannot do the job here: the seeded parent chain terminates at
 * `MAIN_AGENT_ID`, which is the driving agent's id only in the interactive TUI.
 * An ACP root registers as `acp:<sessionId>` and an SDK host names its own, so
 * in exactly the multi-conversation processes that need scoping there is no
 * `Main` ref to inherit from and every seeded agent landed with an UNDEFINED
 * scope. An undefined scope is deliberately visible to everyone, so one
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
		return await registerPersistedSubagentsFromDir(registry, root, undefined, scope);
	} catch (error) {
		logger.warn("Failed to register persisted subagents", { error });
		return 0;
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
				registry.register({
					id: advisorId,
					displayName,
					kind: "advisor",
					parentId: owner,
					session: null,
					sessionFile,
					status: "parked",
					scope,
				});
				registered += 1;
			}
			continue;
		}
		const id = entry.name.slice(0, -6);
		if (!registry.get(id)) {
			registry.register({
				id,
				displayName: id,
				kind: "sub",
				parentId: parentId ?? MAIN_AGENT_ID,
				session: null,
				sessionFile,
				status: "parked",
				scope,
			});
			registered += 1;
		}
		registered += await registerPersistedSubagentsFromDir(registry, path.join(dir, id), id, scope);
	}
	return registered;
}
