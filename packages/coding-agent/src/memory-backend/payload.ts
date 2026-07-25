import { logger } from "@veyyon/utils";
import type { Settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import type { MemoryBackend } from "./types";

/**
 * Everything the memory backend puts in front of the model this turn, rendered
 * for a person to read (`/memory view`).
 *
 * The payload arrives in two pieces and reaches the model in two different
 * places: {@link MemoryBackend.buildDeveloperInstructions} rides in the system
 * prompt and stays put for the session, while
 * {@link MemoryBackend.buildVolatileContext} is delivered at the tail of the
 * conversation each time it changes, so a recall does not rewrite the provider's
 * cache prefix. `/memory view` has to show BOTH: a viewer that showed only the
 * system-prompt half would report an empty payload for a session whose recalled
 * memories are the entire point, which is exactly what happened when the two
 * were split apart.
 *
 * Returns undefined when the backend contributes nothing at all.
 */
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
				error: String(error),
			});
			parts.push(`_The recalled-memory block could not be read: ${String(error)}_`);
		}
	}
	if (parts.length === 0) return undefined;
	return parts.join("\n\n");
}
