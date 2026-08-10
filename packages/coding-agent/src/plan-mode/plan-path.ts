import type { LocalProtocolOptions } from "../internal-urls/local-protocol";
import { resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { normalizeLocalScheme, resolveToCwd } from "../tools/path-utils";

/**
 * The one rule for turning a plan file reference into a filesystem path.
 *
 * A plan reference is either a session-local URL (`local://<slug>-plan.md`, what
 * plan mode tells the agent to write) or an ordinary path relative to the
 * session's working directory (what a stored `mode_change` entry, an ACP client,
 * or an approval can carry). Five call sites wrote the same two-branch test by
 * hand, and one of them left the branch out: `#buildPlanReferenceMessage` ran
 * `resolveLocalUrlToPath` on whatever the field held, so a plan reference with no
 * URL scheme threw `Invalid URL: <path>` out of `prompt()` before the read even
 * happened. That is on the FIRST prompt after a plan is approved and on every one
 * after it, so the session cannot be talked to again, and the crash names a URL
 * the operator never typed.
 *
 * Any resolution of a plan reference goes through here, so a reference the
 * product accepts in one place cannot be a crash in another.
 */
export function resolvePlanFilePath(
	planFilePath: string,
	context: { localProtocol: LocalProtocolOptions; cwd: string },
): string {
	if (planFilePath.startsWith("local:")) {
		return resolveLocalUrlToPath(normalizeLocalScheme(planFilePath), context.localProtocol);
	}
	return resolveToCwd(planFilePath, context.cwd);
}
