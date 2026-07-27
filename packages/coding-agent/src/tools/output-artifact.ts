// Owners, not the `@veyyon/utils` barrel: 2 modules against 74.
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { Settings } from "../config/settings";
import { DEFAULT_MAX_BYTES, type InlineByteCapOptions, resolveInlineCap } from "../session/streaming-output";
import type { ToolSession } from "./index";

/**
 * The two things needed to price a tool result, and nothing else.
 *
 * Deliberately structural rather than `ToolSession`. The same question is asked
 * from a full tool session, from a `CustomToolContext` handed to an MCP or
 * extension tool, and from the centralised artifact spill, and none of those
 * are each other. Requiring the widest type at the one owner is what pushed the
 * other callers into inventing their own flat budget, which is how there came
 * to be two answers to one question.
 */
export interface InlinePricingSource {
	getTurnIndex?: () => number;
	settings?: Settings;
}

/**
 * When a tool result should spill, for one session.
 *
 * This is the ONE owner of "how is this result priced". Every tool that caps
 * its inline output spreads the same two inputs into
 * {@link enforceInlineByteCap}, and reading them separately at each call site
 * is how they drift: one tool ends up scaling by turn and another does not, for
 * no reason anyone chose. Spread this instead and add the `saveArtifact` the
 * tool owns.
 *
 * `turnIndex` is how long the result will sit in context; `floorFraction` is
 * how tightly an early result may be held. Both come from the session, so a
 * lighter tool session that implements neither gets the flat cap, which is the
 * unpriced behaviour and the safe default.
 */
export function inlineOutputPricing(
	session: InlinePricingSource,
): Pick<InlineByteCapOptions, "turnIndex" | "floorFraction" | "maxBytes"> {
	return {
		turnIndex: session.getTurnIndex?.(),
		floorFraction: session.settings?.get("tools.inlineOutputFloor"),
		maxBytes: configuredInlineMaxBytes(session.settings?.get("tools.artifactSpillThreshold")),
	};
}

/**
 * The configured inline budget in BYTES, or `undefined` to take the compiled
 * default.
 *
 * `tools.artifactSpillThreshold` is in kilobytes, and it is the ONE setting that
 * answers "how many bytes of tool output stay in the conversation". It used to
 * answer it for the centralised spill only, while every streaming tool priced
 * itself against a compiled 50KB constant nothing could reach; the two agreed
 * only because both happened to be 50KB, so lowering the setting moved the
 * centralised path and left bash, eval, ssh and the interactive shell where they
 * were. Reading it here is what makes the setting mean what its description says.
 *
 * A threshold of zero or less is not a preference for a very small budget, it is
 * one that elides every tool result down to its ellipsis, and a non-finite one
 * propagates a NaN into every byte comparison downstream so that nothing spills
 * at all. Both are refused, and refused OUT LOUD: a silently corrected setting is
 * one whose value in the file disagrees with the value in effect, with nothing an
 * operator can see (Law 10). A refusal falls back to the compiled default, which
 * is the same answer as not setting it.
 */
function configuredInlineMaxBytes(configuredKb: number | undefined): number | undefined {
	if (configuredKb === undefined) return undefined;
	if (Number.isFinite(configuredKb) && configuredKb > 0) return configuredKb * 1024;
	logger.warn("tools.artifactSpillThreshold is not a positive number of KB; using the compiled default instead", {
		configuredKb,
		usingBytes: DEFAULT_MAX_BYTES,
	});
	return undefined;
}

/**
 * The same budget as {@link inlineOutputPricing}, resolved to a byte count.
 *
 * For a tool that bounds its output some other way than
 * {@link enforceInlineByteCap}. grep is the case: it keeps a HEAD window only,
 * because matches arrive in order and cutting the tail loses the least, whereas
 * a command's output usually matters most at both ends. Those truncation shapes
 * are deliberately different; the budget must not be, or the same bytes are
 * priced one way as a grep result and another as a bash result.
 */
export function inlineBudgetFor(session: InlinePricingSource, maxBytes?: number): number {
	// Conditional, not `{ ...pricing, maxBytes }`: spreading an absent argument
	// writes `maxBytes: undefined` OVER the configured budget, so every caller
	// that does not pass one -- which is all of them -- would silently get the
	// compiled default, and `tools.artifactSpillThreshold` would go on reaching
	// only the centralised path it already reached.
	// A caller that DOES pass one is bounding its output for a reason of its own
	// and still wins.
	return resolveInlineCap({ ...inlineOutputPricing(session), ...(maxBytes !== undefined ? { maxBytes } : {}) });
}

/**
 * Report output that was produced and can no longer be reached.
 *
 * The `artifact://<id>` footer is the ONLY route back to the full bytes: the
 * visible result is a bounded head/tail window and the raw text is kept nowhere
 * else, so a failed write loses output the operator asked for. The caller does
 * carry on with the window it already built, which is why this has to be said
 * out loud rather than inferred from a missing footer.
 *
 * One owner, because two paths reach the same outcome and must say the same
 * thing: the tool spill below, and the session's own `bash-original` save, which
 * writes through `SessionManager` instead of the tool session.
 */
export function reportLostOutputArtifact(toolType: string, error: unknown): void {
	logger.warn("Full tool output could not be saved as an artifact; only the truncated window is recoverable", {
		toolType,
		error: errorMessage(error),
	});
}

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
 * depends on the artifact for correctness of the visible result. It is still
 * reported through {@link reportLostOutputArtifact}, because the footer is the
 * only way back to the full bytes.
 *
 * A session with no `allocateOutputArtifact` at all is a different case and
 * stays silent: an MCP or extension tool context legitimately has no artifact
 * store, so there is nothing to lose and nothing to say.
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
	} catch (error) {
		// Undefined is how the caller learns not to print a footer; the report is how the operator learns
		// the full output is gone, since the window they can see gives no sign of it.
		reportLostOutputArtifact(toolType, error);
		return undefined;
	}
}
