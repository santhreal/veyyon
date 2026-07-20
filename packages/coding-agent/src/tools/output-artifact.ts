import type { ToolSession } from "./index";

/**
 * Persist a tool's full output as a session artifact and return its id, or
 * `undefined` when the session has no artifact store or the write fails.
 *
 * This is the ONE owner of the `allocateOutputArtifact(toolType) + write`
 * pattern. Every tool that offloads oversized output (bash, grep, browser, gh,
 * ...) routes its spill through here, so the `artifact://<id>` recovery
 * contract lives in exactly one place. Pair it with
 * {@link enforceInlineByteCap} as the `saveArtifact` callback.
 *
 * A failed allocation or write returns `undefined` rather than throwing: the
 * inline result the caller already built (a bounded head/tail window) stays
 * intact, only the full-output recovery footer is omitted. The caller never
 * depends on the artifact for correctness of the visible result.
 */
export async function saveOutputArtifact(
	session: ToolSession,
	toolType: string,
	text: string,
): Promise<string | undefined> {
	try {
		const alloc = await session.allocateOutputArtifact?.(toolType);
		if (!alloc?.path || !alloc.id) return undefined;
		await Bun.write(alloc.path, text);
		return alloc.id;
	} catch {
		return undefined;
	}
}
