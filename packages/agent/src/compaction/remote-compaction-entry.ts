/**
 * The transcript-entry contract for provider server-side ("remote") compaction.
 *
 * This module is the leaf every reader imports: it owns what a remote
 * compaction entry stores and how a rebuild turns that storage back into
 * model-visible context. It deliberately has no engine imports so
 * `session-context.ts` can read it from any graph.
 *
 * THE CONTRACT (the dual-write decision, and why):
 *
 * A remote compaction entry is an ordinary `CompactionEntry` — real readable
 * `summary`, real `firstKeptEntryId`, real `tokensBefore` — whose
 * `preserveData[REMOTE_COMPACTION_PRESERVE_KEY]` additionally carries the
 * provider's canonical compacted window verbatim (retained items plus the
 * opaque `compaction` item, per the OpenAI Compaction guide: "do not prune
 * /responses/compact output; the returned window is the canonical next
 * context window").
 *
 * Both halves are always written, because each half covers a rebuild the
 * other cannot:
 *
 * - The NATIVE WINDOW is only meaningful to the provider family that produced
 *   it. On rebuild, `buildSessionContext` attaches it to the compaction
 *   summary message as a `ProviderPayload`; a Responses-family provider then
 *   replays the window INSTEAD of the summary text (the existing
 *   `buildResponsesInput` seam replays user-message payloads containing a
 *   `compaction` item). This preserves encrypted reasoning across the
 *   compaction, which is the entire value of compacting server-side.
 * - The READABLE SUMMARY is what every other rebuild sees: a fork or resume
 *   onto a different provider, a provider row whose capability flag is off,
 *   the display transcript, the session listing, and the next compaction's
 *   `previousSummary`. It is generated locally on the session model at
 *   compaction time, so the log always carries real content — never the
 *   placeholder sentence that stranded sessions written by the removed
 *   provider-native path (see legacy-provider-native.ts).
 *
 * The window is stateless provider data (the endpoint is documented as
 * "fully stateless and ZDR-friendly"), so it survives process restarts and
 * reloads as plain JSON in the session file. What it never survives is a
 * provider switch — which is exactly when the summary takes over.
 *
 * Chaining: a second remote compaction sends the previous window in front of
 * the new span ("The latest compaction item carries the necessary context to
 * continue the conversation") and stores ONLY the newly returned window. A
 * later LOCAL compaction drops the key entirely (`compact()` strips it): its
 * summary already covers the span, and a stale window replayed beside it
 * would double the history.
 */

import type { ProviderPayload } from "@veyyon/ai/types";
import { createOpenAIResponsesHistoryPayload } from "@veyyon/ai/utils";

/** `preserveData` key a server-side compaction entry carries its window under. */
export const REMOTE_COMPACTION_PRESERVE_KEY = "remoteCompaction";

/**
 * What a remote compaction entry stores. `version` lets future readers reject
 * or migrate older payloads instead of misreading them.
 */
export interface RemoteCompactionPreserveData {
	version: 1;
	/** `model.provider` of the compacting model; replay keys on it. */
	provider: string;
	/** `model.api` of the compacting model. */
	api: string;
	/** `model.id` of the compacting model, for display and diagnostics. */
	model: string;
	/** The provider's canonical compacted window, verbatim from the endpoint. */
	window: Array<Record<string, unknown>>;
	/** Token accounting of the compaction call itself, when reported. */
	inputTokens?: number;
	outputTokens?: number;
	/** ISO timestamp of the compaction. */
	compactedAt: string;
}

/**
 * Read and validate the remote-compaction payload of a compaction entry.
 * Returns undefined for absent or malformed data; a malformed payload must
 * degrade to the readable summary, never replay junk at a provider.
 */
export function getRemoteCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
): RemoteCompactionPreserveData | undefined {
	const candidate = preserveData?.[REMOTE_COMPACTION_PRESERVE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const data = candidate as Partial<RemoteCompactionPreserveData>;
	if (data.version !== 1) return undefined;
	if (typeof data.provider !== "string" || data.provider.length === 0) return undefined;
	if (typeof data.api !== "string" || data.api.length === 0) return undefined;
	if (typeof data.model !== "string" || data.model.length === 0) return undefined;
	if (!Array.isArray(data.window) || data.window.length === 0) return undefined;
	// A window without the opaque compaction item is not a compacted window;
	// replaying it would re-send the full span while claiming it was reduced.
	if (
		!data.window.some(
			item => item && typeof item === "object" && item.type === "compaction" && typeof item.encrypted_content === "string",
		)
	) {
		return undefined;
	}
	if (typeof data.compactedAt !== "string" || data.compactedAt.length === 0) return undefined;
	return data as RemoteCompactionPreserveData;
}

/** Responses-family apis whose providers replay a stored window through the native-history seam. */
const REMOTE_COMPACTION_REPLAY_APIS: Record<string, true> = {
	"openai-responses": true,
	"azure-openai-responses": true,
};

/**
 * The provider payload a rebuild attaches to the compaction summary message,
 * or undefined when this entry's window has no replay seam (a future
 * non-Responses transport; those rebuilds use the readable summary).
 * Incremental (`dt: true`): the window stands in place of the summary
 * message, which the rebuild emits first, so append semantics are correct.
 */
export function remoteCompactionProviderPayload(
	preserveData: Record<string, unknown> | undefined,
): ProviderPayload | undefined {
	const data = getRemoteCompactionPreserveData(preserveData);
	if (!data) return undefined;
	if (!REMOTE_COMPACTION_REPLAY_APIS[data.api]) return undefined;
	return createOpenAIResponsesHistoryPayload(data.provider, data.window);
}

/**
 * Display attribution for a remote compaction, e.g. `openai/gpt-5.6-sol`.
 * Anything that names the compaction model must use this: the provider did
 * the compaction server-side, so a configured local compaction model did not
 * apply to it.
 */
export function remoteCompactionAttribution(preserveData: Record<string, unknown> | undefined): string | undefined {
	const data = getRemoteCompactionPreserveData(preserveData);
	return data ? `${data.provider}/${data.model}` : undefined;
}

/**
 * Drop the remote key from a carried-forward preserveData, returning undefined
 * when nothing remains. `compact()` calls this on every local pass: a new
 * local summary covers the span the window covered, so the window must not
 * ride the new entry forward and replay beside it.
 */
export function stripRemoteCompactionPreserveData(
	preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!preserveData || !(REMOTE_COMPACTION_PRESERVE_KEY in preserveData)) return preserveData;
	const { [REMOTE_COMPACTION_PRESERVE_KEY]: _removed, ...rest } = preserveData;
	return Object.keys(rest).length > 0 ? rest : undefined;
}
