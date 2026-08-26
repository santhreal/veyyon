/**
 * The one owner of "which model does this trial run".
 *
 * WHY THIS EXISTS. Three backends each resolved the model themselves and each ended
 * its chain in a different hardcoded literal: the in-process backend fell back to an
 * Anthropic id, the harbor CLI to the same one, the veyyon harness to a Gemini id. A
 * run that named no model therefore ran *some* model and reported it as the arm under
 * test, and the arm's name said nothing about which. A substituted model is not a
 * default, it is a wrong result: the tokens, the spend and the pass rate all belong to
 * a model nobody asked for.
 *
 * The rule here is that a model is named or the trial refuses. The chain is variant →
 * run options → the harness's own declared default (a third-party harness that can
 * only drive one model may declare one), and nothing after that.
 *
 * The id must also be provider-qualified, because every backend splits it: harbor
 * writes a per-trial `models.yml` whose provider section is keyed by the provider,
 * pier passes the id through to its agent kwargs, and the in-process client resolves
 * the provider through the catalog. A bare `gpt-5` reaches a provider section named
 * after nothing.
 */
import type { RunContext, Variant } from "./types";

/** No axis named a model, and the harness declares no default of its own. */
export class ModelNotNamedError extends Error {
	constructor(variantName: string, harnessName: string) {
		super(
			`Variant "${variantName}" names no model, harness "${harnessName}" declares no default, and no run option names one. ` +
				`Pass --model <provider/model-id>: a run that substitutes a model reports another model's result under this arm's name.`,
		);
		this.name = "ModelNotNamedError";
	}
}

/** The id is not `provider/model-id`, so no backend can route it. */
export class MalformedModelIdError extends Error {
	constructor(id: string) {
		super(
			`Model id ${JSON.stringify(id)} is not provider-qualified. Write it as <provider>/<model-id> ` +
				`(for example anthropic/claude-sonnet-4-6, openrouter/openai/gpt-oss-120b): the provider selects the ` +
				`credential and the endpoint, and neither is inferable from a bare model name.`,
		);
		this.name = "MalformedModelIdError";
	}
}

/** A provider-qualified model id, split the one way every backend splits it. */
export interface TrialModel {
	/** The full id exactly as named, which is what a run record reports. */
	readonly id: string;
	/** Everything before the first slash. */
	readonly provider: string;
	/** Everything after the first slash, slashes included: a provider may namespace its ids. */
	readonly model: string;
}

/** Split a provider-qualified id at its FIRST slash, or refuse. */
export function parseModelId(id: string): TrialModel {
	const trimmed = id.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) throw new MalformedModelIdError(id);
	const provider = trimmed.slice(0, slash);
	const model = trimmed.slice(slash + 1);
	if (/\s/.test(provider) || /\s/.test(model)) throw new MalformedModelIdError(id);
	return { id: trimmed, provider, model };
}

/** What a backend needs from the harness to resolve a model: its name and its own default. */
export interface ModelDefaultSource {
	readonly name: string;
	readonly defaultModel: string | null;
}

/**
 * The model this trial runs, or a refusal naming what to pass.
 *
 * @param variant the plan's variant for this cell, the first and strongest source
 * @param harness the harness the variant names, consulted only for its own default
 * @param context the run, whose `options.model` covers a caller that plans no model axis
 */
export function resolveTrialModel(
	variant: Variant,
	harness: ModelDefaultSource,
	context: Pick<RunContext, "options">,
): TrialModel {
	const optionModel = typeof context.options?.model === "string" ? context.options.model : null;
	const named = variant.model || optionModel || harness.defaultModel;
	if (!named) throw new ModelNotNamedError(variant.name, harness.name);
	return parseModelId(named);
}
