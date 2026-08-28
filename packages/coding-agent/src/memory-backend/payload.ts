import { errorMessage, logger } from "@veyyon/utils";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { MemoryBackend } from "./types";

/** Everything the memory backend puts in front of the model this turn, rendered for a person to read (`/memory view`). */
export async function buildMemoryPayloadForDisplay(
	backend: MemoryBackend,
	agentDir: string,
	settings: Settings,
	session?: AgentSession,
): Promise<string | undefined> {
	const parts: string[] = [];
	const instructions = await backend.buildDeveloperInstructions(agentDir, settings, session);
	if (instructions?.trim()) parts.push(instructions.trim());
	if (session && backend.buildVolatileContext) {
		try {
			const volatileContext = await backend.buildVolatileContext(session);
			if (volatileContext?.trim()) parts.push(volatileContext.trim());
		} catch (error) {
			// Shown to the operator rather than swallowed: an empty-looking payload
			// with no explanation is the failure this function exists to prevent.
			logger.warn("Memory view: the backend's volatile context could not be read", {
				backend: backend.id,
				error: errorMessage(error),
			});
			parts.push(`_The recalled-memory block could not be read: ${errorMessage(error)}_`);
		}
	}
	if (parts.length === 0) return undefined;
	return parts.join("\n\n");
}
