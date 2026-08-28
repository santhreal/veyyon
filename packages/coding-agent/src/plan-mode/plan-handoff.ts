import { isEnoent } from "@veyyon/utils";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../internal-urls/local-protocol";

/** The session's active plan, resolved for handoff into a subagent's context. */
export interface OverallPlanReference {
	/** The `local://` reference path (e.g. `local://my-feature.md`), kept for display. */
	path: string;
	/** The full plan markdown, as written to disk. */
	content: string;
}

/** Load the session's active overall plan for subagent handoff. Returns the plan referenced by `planReferencePath` when it exists on disk with */
export async function loadOverallPlanReference(
	planReferencePath: string,
	localProtocolOptions: LocalProtocolOptions,
): Promise<OverallPlanReference | undefined> {
	const resolved = resolveLocalUrlToPath(planReferencePath, localProtocolOptions);
	let content: string;
	try {
		content = await Bun.file(resolved).text();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	if (!content.trim()) return undefined;
	return { path: planReferencePath, content };
}
