/**
 * The transcript-entry contract for provider server-side ("remote") compaction.
 *
 * This module is the leaf every reader imports: it owns what a remote
 * compaction entry stores and how a rebuild turns that storage back into
 * model-visible context. It deliberately has no engine imports so
 * `session-context.ts` can read it from any graph.
 *
 * WHEN THIS APPLIES. Server-side compaction runs only when the operator turns
 * `compaction.remote` on AND `resolveServerCompactionTransport` admits the
 * model. Admission is capability data, never a provider-name check: the model
 * must be on the OpenAI Responses wire api (so Azure OpenAI Responses
 * deployments qualify, and OpenAI Codex does not, its api is a different one)
 * AND its model row must report server-compaction support, which a host
 * resolves at build time and config or discovery can flip per row. Anything
 * else compacts locally on the ordinary summary path.
 *
 * Do not confuse this with `compaction.remoteEndpoint` and
 * `remote-summarizer.ts`. That is a separate feature: an operator-configured
 * external endpoint that returns summary TEXT for the local `summary`
 * strategy. Neither replaces the other. They only share the word "remote".
 *
 * THE CONTRACT: one compaction, one artifact.
 *
 * A remote compaction entry is a `CompactionEntry` with a real
 * `firstKeptEntryId`, a real `tokensBefore`, an EMPTY `summary`, and the
 * provider's canonical compacted window verbatim under
 * `preserveData[REMOTE_COMPACTION_PRESERVE_KEY]` (retained items plus the
 * opaque `compaction` item, per the OpenAI Compaction guide: "do not prune
 * /responses/compact output; the returned window is the canonical next
 * context window"). The window IS the artifact for that span.
 *
 * The empty summary is deliberate, and it is not a gap waiting to be filled.
 * Writing a local summary alongside the window would mean paying a model to
 * summarize a span the provider has already compacted, and then keeping two
 * accounts of one range that are free to disagree the moment either side is
 * regenerated. So there is no second half, and code that assumes one is wrong.
 * `assertValidCompactionResult` encodes this: an empty summary is valid only
 * when a well-formed window is present.
 *
 * What the single artifact costs, and who pays it:
 *
 * - REPLAY is provider-bound. On rebuild, `buildSessionContext` attaches the
 *   window to the compaction summary message as a `ProviderPayload`, and a
 *   Responses-family provider replays it INSTEAD of summary text (the
 *   `buildResponsesInput` seam replays user-message payloads containing a
 *   `compaction` item). This preserves encrypted reasoning across the
 *   compaction, which is the entire reason to compact server-side.
 * - EVERY OTHER READER sees no summary text, because there is none: a fork or
 *   resume onto a different provider, a provider row whose capability flag is
 *   off, the display transcript, the session listing. Those readers must fall
 *   back to the underlying messages rather than to a summary. That fallback is
 *   `hasReusableSummary` in compaction.ts, which refuses to treat such an entry
 *   as a reusable prior compaction so the span behind it is re-expanded and
 *   summarized locally on the next pass.
 *
 * The window is stateless provider data (the endpoint is documented as
 * "fully stateless and ZDR-friendly"), so it survives process restarts and
 * reloads as plain JSON in the session file. What it never survives is a
 * provider switch, which is exactly when re-expansion takes over.
 *
 * Chaining: a second remote compaction sends the previous window in front of
 * the new span ("The latest compaction item carries the necessary context to
 * continue the conversation") and stores ONLY the newly returned window. A
 * later LOCAL compaction drops the key entirely (`compact()` strips it): its
 * summary covers the span, and a stale window replayed beside it would double
 * that history.
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
			item =>
				item &&
				typeof item === "object" &&
				item.type === "compaction" &&
				typeof item.encrypted_content === "string",
		)
	) {
		return undefined;
	}
	if (typeof data.compactedAt !== "string" || data.compactedAt.length === 0) return undefined;
	return data as RemoteCompactionPreserveData;
}

/**
 * The previously stored window a NEW server-side compaction may chain in
 * front of its span, or undefined when the compaction must start fresh.
 *
 * WHY identity decides this, and not the mere presence of a window: a
 * compacted window is not portable data. Its `compaction` item is an opaque
 * `encrypted_content` blob that only the host which minted it can decrypt,
 * and because the endpoint is documented as fully stateless that blob IS the
 * conversation state — there is nothing else for a different host to read it
 * with. So a window is bound to the exact provider and api that produced it.
 * A session that switches hosts mid-run (openai -> azure, or the reverse)
 * still has the old window sitting in `previousPreserveData`, and sending it
 * to the new host buys a guaranteed provider rejection: a wasted compaction
 * round trip, a user-visible warning, and a fall back to local compaction at
 * the exact moment the context is overflowing. Dropping the window instead
 * costs only the extra span the fresh compaction has to read, and the
 * readable summary of that span is carried forward regardless.
 *
 * This is the write-side twin of the read-side check: replay drops a foreign
 * window in `getOpenAIResponsesHistoryPayload`, and `remoteCompactionProviderPayload`
 * keys on `data.provider` for the same reason. Both directions gate on the
 * `provider`/`api` this module records precisely so a window is never read by
 * a model that cannot read it.
 */
export function chainableRemoteCompactionWindow(
	preserveData: Record<string, unknown> | undefined,
	model: { provider: string; api: string },
): Array<Record<string, unknown>> | undefined {
	const data = getRemoteCompactionPreserveData(preserveData);
	if (!data) return undefined;
	if (data.provider !== model.provider || data.api !== model.api) return undefined;
	return data.window;
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
