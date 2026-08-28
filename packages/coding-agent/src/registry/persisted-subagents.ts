import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@veyyon/utils";
import { advisorTranscriptSlug, isSessionFileName, SESSION_BACKUP_EXTENSION } from "@veyyon/utils/session-file";
import { isAdvisorTranscriptName } from "../advisor";
import { type AgentRegistry, MAIN_AGENT_ID } from "./agent-registry";

export async function registerPersistedSubagents(
	registry: AgentRegistry,
	sessionFile: string | null | undefined,
	scope?: string,
): Promise<number> {
	if (!sessionFile || !isSessionFileName(sessionFile)) return 0;
	const root = sessionFile.slice(0, -6);
	try {
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
		if (isAdvisorTranscriptName(entry.name)) {
			const owner = parentId ?? MAIN_AGENT_ID;
			const slug = advisorTranscriptSlug(entry.name);
			const advisorId = slug ? `${owner}/advisor:${slug}` : `${owner}/advisor`;
			const displayName = slug ? `advisor:${slug}` : "advisor";
			const existing = registry.get(advisorId);
			if (existing && existing.kind !== "advisor") continue;
			if (existing?.sessionFile !== sessionFile) {
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
