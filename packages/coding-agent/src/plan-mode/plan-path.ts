import type { LocalProtocolOptions } from "../internal-urls/local-protocol";
import { resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";

/** The one rule for turning a plan file reference into a filesystem path. A plan reference is either a session-local URL (`local://<slug>-plan.md`, what */
export function resolvePlanFilePath(
	planFilePath: string,
	context: { localProtocol: LocalProtocolOptions; cwd: string },
): string {
	if (planFilePath.startsWith("local:")) {
		return resolveLocalUrlToPath(normalizeLocalScheme(planFilePath), context.localProtocol);
	}
	return resolveToCwd(planFilePath, context.cwd);
}
