/**
 * Token limits for an agent-gateway model, resolved from what is actually known about that model.
 *
 * WHY THIS EXISTS. Antigravity, Cursor and Devin are gateways: they proxy other vendors' models and report
 * little or nothing about the limits of what they are proxying. Cursor reports no limits at all, Devin reports
 * one number that has to serve as both, and Antigravity's fields are frequently absent. Every one of the three
 * used to fall straight to {@link AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW}, so a gateway-hosted `grok-4.5` was
 * described as a 200k model when the model has a 500k window, and a Gemini row as 200k against 1M. That number
 * is not cosmetic: auto-compaction, the context panel, context promotion and the overflow check all read it, so
 * the agent compacted at two fifths of the window it had and told the operator their 256k threshold was larger
 * than the model's context.
 *
 * WHAT IS DIFFERENT NOW. The gateway not reporting a window does not mean nothing is known about the model. The
 * bundled catalog carries the same model under the vendor that hosts it directly (`xai/grok-4.5`,
 * `google/gemini-3-pro`), and the reference index already resolves a proxied id onto that entry — it is what the
 * proxy/reseller path uses for pricing and capabilities. So the order is: what the gateway reported, then what
 * the catalog knows about that model, and only then the gateway assumption.
 *
 * THE CATALOG IS NOT ASKED ABOUT ITSELF. The bundled catalog also carries the gateways' OWN rows, written by a
 * previous discovery run: `cursor/gpt-5.1-high` sits there at 200k because that is what this module's ancestor
 * assumed. Resolving against the whole catalog therefore answered a gateway's question with the gateway's own
 * assumption one indirection removed, which is the original defect wearing a disguise — and it reached exactly
 * the ids the gateway actually serves, since those are the ids a discovery run wrote down. The index consulted
 * here is built from rows that are evidence about a model: not a gateway's own row, and not a row that is
 * numerically indistinguishable from the assumption below (which no answer can be worse than, since discarding
 * it lands on that same pair).
 *
 * The assumption is still the floor rather than the answer, because being too LOW is the safe direction: an
 * over-estimate makes the agent keep filling a window the model does not have until the provider rejects the
 * request, while an under-estimate only compacts earlier than it needed to.
 */
import { buildModelReferenceIndex, type ModelReferenceIndex, resolveModelReference } from "../identity/reference";
import { getBundledModels, getBundledProviders } from "../models";
import type { Api, Model } from "../types";
import { stripEffortTierSuffix } from "../variant-collapse";
import { AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW, AGENT_GATEWAY_DEFAULT_MAX_TOKENS } from "./default-limits";

/**
 * Providers whose bundled rows are a gateway's own description of somebody else's model, keyed to why they are
 * not evidence about it. A row here says what a discovery run assumed or what the gateway reported about its
 * proxy, and neither is a statement about the model, so none of them may answer a question asked here.
 *
 * Every id is a member of the provider catalog table, and every gateway whose discovery calls into this module
 * appears here: `test/gateway-model-limits.test.ts` drives each gateway's real discovery, reads the provider id
 * off the rows it produces, and fails when one of them is missing from this table or absent from the catalog.
 */
export const GATEWAY_ROW_PROVIDERS: Record<string, string> = {
	cursor: "reports no limits at all, so every limit on a cursor row was assumed by discovery",
	devin: "reports one number for both limits, so a devin row's output cap was assumed by discovery",
	"google-antigravity": "reports limit fields that are frequently absent",
	"gitlab-duo": "gateway rows for GitLab's proxied Anthropic and Gemini models",
	"gitlab-duo-agent": "resolves its windows from its own pattern table rather than from the proxied model",
};

/** A limit a gateway reported. Anything not a positive finite number is "not told", not zero. */
function reportedLimit(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Whether a bundled row says anything about the model it names beyond this module's own assumption.
 *
 * Two rows fail: one published by a gateway (see {@link GATEWAY_ROW_PROVIDERS}), and one carrying exactly the
 * assumed pair with no pricing at all, which is the shape every gateway row had before this module existed and
 * is how a gateway nobody has classified yet still cannot launder its guess back in. Discarding the second kind
 * costs nothing even when the row was honest: the answer without it is the same pair.
 */
function isEvidenceAboutTheModel(row: Model<Api>): boolean {
	if (GATEWAY_ROW_PROVIDERS[row.provider] !== undefined) return false;
	return !(
		row.contextWindow === AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW &&
		row.maxTokens === AGENT_GATEWAY_DEFAULT_MAX_TOKENS &&
		row.cost.input === 0 &&
		row.cost.output === 0 &&
		row.cost.cacheRead === 0 &&
		row.cost.cacheWrite === 0
	);
}

let evidenceIndex: ModelReferenceIndex | undefined;

/**
 * Reference index over the rows that are evidence about a model. Memoized: the walk over every bundled model
 * triggers thinking enrichment, and discovery normalizes a whole catalog one row at a time.
 */
function getEvidenceReferenceIndex(): ModelReferenceIndex {
	evidenceIndex ??= buildModelReferenceIndex(
		getBundledProviders().flatMap(provider => getBundledModels(provider).filter(isEvidenceAboutTheModel)),
	);
	return evidenceIndex;
}

/**
 * A gateway's speed marker: the same model on faster infrastructure (`gpt-5.4-medium-fast`, `swe-1-6-fast`).
 * Kept here rather than in the effort-tier vocabulary because it is not an effort: it changes neither how the
 * model thinks nor how much context it has, and it is a gateway id spelling rather than a vendor one.
 */
const GATEWAY_SPEED_SUFFIX_RE = /-(?:fast|slow)$/;

/**
 * A gateway that cannot put a dot in an id writes the version with a dash: Devin serves `gpt-5-4`,
 * `gemini-3-1-pro` and `kimi-k2-7` for models the vendors publish as `gpt-5.4`, `gemini-3.1-pro` and
 * `kimi-k2.7`. Only a dash BETWEEN two digits is a version separator; the dashes around words are the
 * vendor's own. Without this the resolver was inert for most of Devin's catalog, which is the defect it
 * exists to fix: a silent `gemini-3-1-pro` row was published at a fifth of its window.
 */
const GATEWAY_VERSION_DASH_RE = /(\d)-(\d)/g;

/**
 * A gateway that writes its own name into the model id: Cursor serves `cursor-grok-4.5-medium` for xAI's
 * `grok-4.5`, and every one of those ids resolved to nothing, so the whole prefixed half of its catalog was
 * published at the assumption. That is the defect this file exists to prevent, arriving through a spelling
 * rather than a missing row: an operator running `cursor/cursor-grok-4.5-medium` was told they had 200k of a
 * 500k model, and their compaction threshold was capped against a window two and a half times too small.
 *
 * The vocabulary is every provider id the bundled catalog carries, read at run time rather than listed here, so
 * a new gateway needs no edit. The longest match wins, because provider ids contain dashes
 * (`vercel-ai-gateway-gpt-5.4` must not strip `vercel`). The bare provider id with nothing after it is not a
 * model id and is left alone.
 */
let gatewayNamePrefixes: string[] | undefined;

function getGatewayNamePrefixes(): string[] {
	gatewayNamePrefixes ??= getBundledProviders()
		.map(provider => `${provider}-`)
		.sort((left, right) => right.length - left.length);
	return gatewayNamePrefixes;
}

function stripGatewayNamePrefix(candidate: string): string | undefined {
	const lowered = candidate.toLowerCase();
	for (const prefix of getGatewayNamePrefixes()) {
		if (!lowered.startsWith(prefix)) continue;
		const rest = candidate.slice(prefix.length);
		return rest.length > 0 ? rest : undefined;
	}
	return undefined;
}

/**
 * The ids to try for a gateway model, nearest first: the id itself, then the same id with one gateway affix
 * removed or one spelling normalized, and so on. Each rewrite has to compose with the others in any order,
 * since a gateway stacks them (`cursor-grok-4.5-medium` is a prefixed base model at a fixed effort,
 * `gpt-5-4-high-fast` is a dash-spelled base model at high effort on fast infrastructure, and no single
 * rewrite reaches the base).
 *
 * The walk ends because every rewrite strictly reduces the pair (length, dashes between digits) and no
 * candidate is ever visited twice, so the list is finite, free of duplicates, and holds nothing longer than
 * the id it started from. Exported for the suite that asserts exactly that: a rewrite which lengthens a
 * candidate, or a lost visited check, turns this queue into a walk that never returns, and a resolver that
 * never returns hangs discovery instead of publishing a wrong number.
 */
export function gatewayIdCandidates(modelId: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const queue = [modelId.trim()];
	for (let index = 0; index < queue.length; index += 1) {
		const candidate = queue[index];
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		candidates.push(candidate);
		const tierBase = stripEffortTierSuffix(candidate);
		if (tierBase !== undefined) queue.push(tierBase);
		const speedBase = candidate.replace(GATEWAY_SPEED_SUFFIX_RE, "");
		if (speedBase !== candidate && speedBase.length > 0) queue.push(speedBase);
		const dotted = candidate.replace(GATEWAY_VERSION_DASH_RE, "$1.$2");
		if (dotted !== candidate) queue.push(dotted);
		const unprefixed = stripGatewayNamePrefix(candidate);
		if (unprefixed !== undefined) queue.push(unprefixed);
	}
	return candidates;
}

/**
 * The catalog's own entry for a gateway model id, or undefined when nothing known describes it.
 *
 * An effort-tiered id (`grok-4.5-medium`, `gpt-5.4-high-fast`) is the base model at a fixed effort, so it
 * resolves through its base: the tier changes how the model thinks, never how much context it has.
 */
export function gatewayModelReference(modelId: string): Model<Api> | undefined {
	const index = getEvidenceReferenceIndex();
	for (const candidate of gatewayIdCandidates(modelId)) {
		const reference = resolveModelReference(candidate, index);
		if (reference) return reference;
	}
	return undefined;
}

/**
 * Resolve a gateway model's context window: reported, else the catalog's number for that model, else the
 * gateway assumption.
 */
export function gatewayContextWindow(modelId: string, reported?: number): number {
	const told = reportedLimit(reported);
	if (told !== undefined) return told;
	const known = reportedLimit(gatewayModelReference(modelId)?.contextWindow);
	return known ?? AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW;
}

/**
 * Resolve a gateway model's output cap the same way.
 *
 * Unlike the context window this is capped at the gateway assumption when it comes from the catalog: an output
 * budget above what the gateway will actually produce is refused outright by some of them rather than clamped,
 * and the vendor's own cap is not a promise about the proxy. A number the gateway itself reported is trusted as
 * given, because that one IS a statement about the proxy.
 */
export function gatewayMaxTokens(modelId: string, reported?: number): number {
	const told = reportedLimit(reported);
	if (told !== undefined) return told;
	const known = reportedLimit(gatewayModelReference(modelId)?.maxTokens);
	return known === undefined ? AGENT_GATEWAY_DEFAULT_MAX_TOKENS : Math.min(known, AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
}
