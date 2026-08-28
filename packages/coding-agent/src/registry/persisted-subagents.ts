/** Seed the agent registry with the subagents of previous runs. The registry only knows agents this PROCESS started. Restart veyyon, or come */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { advisorTranscriptSlug, isSessionFileName, SESSION_BACKUP_EXTENSION } from "@veyyon/utils/session-file";
import { isAdvisorTranscriptName } from "../advisor";
import { type AgentRegistry, MAIN_AGENT_ID } from "./agent-registry";

/** Register every persisted subagent under `sessionFile`'s own directory, and report how many were added. */
export async function registerPersistedSubagents(
	registry: AgentRegistry,
	sessionFile: string | null | undefined,
	scope?: string,
): Promise<number> {
	if (!sessionFile || !isSessionFileName(sessionFile)) return 0;
	const root = sessionFile.slice(0, -6);
	try {
		// The driving agent of this conversation owns every subagent seeded from its directory. Resolved by role rather than assumed to answer to one
		const owner = registry.mainInScope(scope)?.id ?? MAIN_AGENT_ID;
		return await registerPersistedSubagentsFromDir(registry, root, owner, scope);
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
