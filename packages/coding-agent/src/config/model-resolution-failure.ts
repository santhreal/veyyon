export interface ModelResolutionContext {
	readonly requested: readonly string[];
	readonly allModelIds: readonly string[];
	readonly availableModelIds: readonly string[];
	readonly registryError?: string;
}

export type ModelResolutionFailureKind =
	| "registry-error"
	| "empty-registry"
	| "no-credentials"
	| "provider-unauthenticated"
	| "unknown-model";

export interface ModelResolutionFailure {
	readonly kind: ModelResolutionFailureKind;
	readonly message: string;
	readonly nearMatches: readonly string[];
}

function describeRequested(requested: readonly string[]): string {
	if (requested.length === 0) return "a model";
	if (requested.length === 1) return `"${requested[0]}"`;
	return `one of ${requested.map(pattern => `"${pattern}"`).join(", ")}`;
}

function providersOf(ids: readonly string[]): string[] {
	const seen: string[] = [];
	for (const id of ids) {
		const provider = id.includes("/") ? (id.split("/")[0] as string) : id;
		if (!seen.includes(provider)) seen.push(provider);
	}
	return seen;
}

export function findNearMatches(pattern: string, ids: readonly string[], limit = 5): string[] {
	const needle = pattern.toLowerCase();
	const bare = needle.includes("/") ? (needle.split("/").pop() as string) : needle;
	const scored: { id: string; score: number }[] = [];
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
			let shared = 0;
			while (shared < bare.length && shared < idPart.length && bare[shared] === idPart[shared]) shared++;
			if (shared >= 4) score = 1;
		}
		if (score > 0) scored.push({ id, score });
	}
	scored.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
	return scored.slice(0, limit).map(entry => entry.id);
}

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

export interface ModelRegistryView {
	getAll(): readonly { readonly provider: string; readonly id: string }[];
	getAvailable(): readonly { readonly provider: string; readonly id: string }[];
	getError?(): { readonly message: string } | undefined;
}

export function modelResolutionFailureMessage(requested: readonly string[], registry: ModelRegistryView): string {
	const qualify = (entry: { provider: string; id: string }) => `${entry.provider}/${entry.id}`;
	return describeModelResolutionFailure({
		requested,
		allModelIds: registry.getAll().map(qualify),
		availableModelIds: registry.getAvailable().map(qualify),
		registryError: registry.getError?.()?.message,
	}).message;
}
