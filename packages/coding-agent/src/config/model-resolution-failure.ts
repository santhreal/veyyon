/**
 * Saying WHY a requested model could not be resolved.
 *
 * WHY THIS EXISTS. Model resolution can fail for four unrelated reasons, and
 * they used to collapse into one sentence: `Model "<id>" not found`, followed by
 * "Set an API key environment variable". That sentence blames the id the
 * operator typed, so when the real cause was a credential that could no longer
 * serve a token, the message pointed at the one thing that was correct.
 *
 * The cost was not hypothetical. A 40-trial bench run hard-errored on a model id
 * that had passed 15/15 hours earlier on the same recipe; the message said the
 * id was not found, so the id was blamed. That produced a false permanent code
 * comment asserting the model was "live-discovery-gated", arm allowlists edited
 * to avoid it, and eventually a whole sandbox model gate built to block a model
 * that demonstrably worked. All of it was reverted. The credential had expired.
 *
 * So the rule here: an EMPTY registry, or a registry with no usable credentials,
 * is an authentication or availability failure and must say so. Only a registry
 * that genuinely holds models none of which match the request is an id error, and
 * that case owes the operator near-matches instead of a bare denial.
 *
 * AND THE REMEDY MUST BE ONE THE READER CAN RUN. Three of these branches used to
 * end in `/login` or `/model`. Both are TUI-only slash commands: `/login` calls
 * `showLogin` and `/model` opens the model selector, so neither exists
 * for the readers that reach this module most often. The FIRST caller is
 * `main.ts`, which throws this text at CLI startup, and `bench-cli.ts` and
 * `veyyon commit` reach it too, all with no terminal UI. Naming a command the
 * reader cannot type is worse than naming none: it ends the search at a dead
 * end. Every remedy below is a shell command that works in every channel, with
 * the slash shortcut named as the interactive alternative rather than the only
 * route.
 */

/** What was known at the moment resolution failed. Ids are `provider/id`. */
export interface ModelResolutionContext {
	/** The `--model` patterns the operator asked for, in order. */
	readonly requested: readonly string[];
	/** Every model the registry knows, with or without credentials. */
	readonly allModelIds: readonly string[];
	/** The subset that has configured auth. */
	readonly availableModelIds: readonly string[];
	/** A registry load/discovery error, when one was recorded. */
	readonly registryError?: string;
}

export type ModelResolutionFailureKind =
	/** The registry itself failed to load. Nothing about the id can be concluded. */
	| "registry-error"
	/** The registry is empty for a non-error reason. */
	| "empty-registry"
	/** Models exist, none has usable credentials. An AUTH failure, not an id failure. */
	| "no-credentials"
	/** The id names real models, but none of their providers is authenticated. */
	| "provider-unauthenticated"
	/** Models with credentials exist and none matches the request. A genuine id error. */
	| "unknown-model";

export interface ModelResolutionFailure {
	readonly kind: ModelResolutionFailureKind;
	readonly message: string;
	/** Authenticated ids resembling the request; only for `unknown-model`. */
	readonly nearMatches: readonly string[];
}

/** How the operator's patterns read back in a sentence. */
function describeRequested(requested: readonly string[]): string {
	if (requested.length === 0) return "a model";
	if (requested.length === 1) return `"${requested[0]}"`;
	return `one of ${requested.map(pattern => `"${pattern}"`).join(", ")}`;
}

/** Providers named by ids, in first-seen order. */
function providersOf(ids: readonly string[]): string[] {
	const seen: string[] = [];
	for (const id of ids) {
		const provider = id.includes("/") ? (id.split("/")[0] as string) : id;
		if (!seen.includes(provider)) seen.push(provider);
	}
	return seen;
}

/**
 * Ids that loosely resemble a pattern, so an operator who mistyped or misremembered
 * a version sees the real spelling rather than only being told no.
 *
 * Substring matching in both directions, on the bare id as well as the qualified
 * one, catches the mistakes people actually make: a provider prefix left off, a
 * suffix like `-latest` invented, a version digit wrong.
 */
export function findNearMatches(pattern: string, ids: readonly string[], limit = 5): string[] {
	const needle = pattern.toLowerCase();
	const bare = needle.includes("/") ? (needle.split("/").pop() as string) : needle;
	const scored: { id: string; score: number }[] = [];
	// A fragment shorter than three characters is a substring of most of a real
	// catalog, so it produces a suggestion list that suggests nothing. Only an
	// exact hit counts below that length.
	const tooShortToInfer = bare.length < 3;
	for (const id of ids) {
		const haystack = id.toLowerCase();
		const idPart = haystack.includes("/") ? (haystack.split("/").pop() as string) : haystack;
		let score = 0;
		if (haystack === needle) score = 5;
		else if (tooShortToInfer) score = 0;
		else if (idPart === bare) score = 4;
		else if (haystack.includes(bare) || idPart.includes(bare)) score = 3;
		else if (bare.includes(idPart) && idPart.length >= 3) score = 2;
		else {
			// A shared leading run of at least four characters is enough signal to
			// suggest; shorter runs match far too much of a large catalog.
			let shared = 0;
			while (shared < bare.length && shared < idPart.length && bare[shared] === idPart[shared]) shared++;
			if (shared >= 4) score = 1;
		}
		if (score > 0) scored.push({ id, score });
	}
	scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
	return scored.slice(0, limit).map(entry => entry.id);
}

/**
 * Classify a resolution failure and produce the operator-facing sentence.
 *
 * The ordering of the checks is the contract. A registry error outranks
 * everything, because with a broken registry no claim about the id is
 * supportable. Credential state outranks id matching, because "not found" is
 * only true when there was something to search.
 */
export function describeModelResolutionFailure(context: ModelResolutionContext): ModelResolutionFailure {
	const requested = describeRequested(context.requested);

	if (context.registryError) {
		return {
			kind: "registry-error",
			message:
				`The model registry could not be loaded, so ${requested} could not be resolved: ` +
				`${context.registryError}. Fix the model configuration and retry; the model id is not the problem.`,
			nearMatches: [],
		};
	}

	if (context.allModelIds.length === 0) {
		return {
			kind: "empty-registry",
			message:
				`No models are known to this installation, so ${requested} could not be resolved. ` +
				"This is not an unknown model id: the registry is empty. Check your model configuration.",
			nearMatches: [],
		};
	}

	if (context.availableModelIds.length === 0) {
		const providers = providersOf(context.allModelIds).slice(0, 5);
		return {
			kind: "no-credentials",
			message:
				`No models are available: the registry knows ${context.allModelIds.length} model(s) but none has ` +
				`usable credentials, so ${requested} could not be resolved. This is an authentication failure, not ` +
				`an unknown model id. Fix: run \`veyyon auth-broker login <provider>\` for one of ` +
				`${providers.join(", ")}, or set that provider's API key environment variable ` +
				`(\`/login\` in an interactive veyyon session).`,
			nearMatches: [],
		};
	}

	// The id names real models, but every provider behind them is unauthenticated.
	// Telling this operator the model does not exist would be plainly false.
	const matchedUnauthenticated = context.requested.flatMap(pattern =>
		findNearMatches(pattern, context.allModelIds, Number.MAX_SAFE_INTEGER).filter(
			id => !context.availableModelIds.includes(id),
		),
	);
	const exactUnauthenticated = matchedUnauthenticated.filter(id =>
		context.requested.some(pattern => {
			const needle = pattern.toLowerCase();
			const haystack = id.toLowerCase();
			return haystack === needle || (haystack.split("/").pop() as string) === needle;
		}),
	);
	if (exactUnauthenticated.length > 0) {
		const providers = providersOf(exactUnauthenticated);
		return {
			kind: "provider-unauthenticated",
			message:
				`${requested} exists but has no usable credentials for ${providers.join(", ")}. ` +
				`The model id is correct. Fix: run \`veyyon auth-broker login ${providers[0]}\`, or set that ` +
				`provider's API key environment variable (\`/login\` in an interactive veyyon session).`,
			nearMatches: [],
		};
	}

	const nearMatches = [
		...new Set(context.requested.flatMap(pattern => findNearMatches(pattern, context.availableModelIds))),
	].slice(0, 5);
	return {
		kind: "unknown-model",
		message:
			`Model ${requested} not found among ${context.availableModelIds.length} model(s) with usable credentials` +
			(nearMatches.length > 0
				? `. Did you mean: ${nearMatches.join(", ")}?`
				: ". Run `veyyon models` to list them (`/model` in an interactive veyyon session)."),
		nearMatches,
	};
}

/**
 * The part of `ModelRegistry` this diagnosis needs.
 *
 * Structural rather than the concrete class so the module stays a leaf: it must
 * be importable by `main.ts`, the slash-command registry and the CLIs without
 * dragging the registry implementation, and testable without constructing one.
 */
export interface ModelRegistryView {
	getAll(): readonly { readonly provider: string; readonly id: string }[];
	getAvailable(): readonly { readonly provider: string; readonly id: string }[];
	getError?(): { readonly message: string } | undefined;
}

/**
 * The operator-facing sentence for a resolution failure, read straight off a
 * registry.
 *
 * THE single entry point every call site should use. Each site previously built
 * its own `Model "<id>" not found` string, so the id was blamed for credential
 * and registry failures in six different places, and fixing one left the other
 * five. Taking the registry here also keeps the `provider/id` projection in one
 * place instead of repeating it per call site.
 */
export function modelResolutionFailureMessage(requested: readonly string[], registry: ModelRegistryView): string {
	const qualify = (entry: { provider: string; id: string }) => `${entry.provider}/${entry.id}`;
	return describeModelResolutionFailure({
		requested,
		allModelIds: registry.getAll().map(qualify),
		availableModelIds: registry.getAvailable().map(qualify),
		registryError: registry.getError?.()?.message,
	}).message;
}
