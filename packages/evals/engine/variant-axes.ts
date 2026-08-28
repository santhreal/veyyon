/**
 * Which variant axes a run can actually apply.
 *
 * The variant matrix is a product of five axes, but only the harness and the model reach
 * every backend. A config overlay, a prompt-variant overlay and an arm attachment each
 * need someone to read them: the in-process backend applies a config overlay and prompt
 * overrides, pier applies a config overlay and attachments, harbor applies neither. A
 * harness has its own say, because prompt overrides and arm attachments are rewrites of
 * the agent's own inputs and an adapter that cannot perform them declares so.
 *
 * Nothing read those declarations, so `--prompts a.json,b.json` against a backend that
 * drops the path expanded the matrix, named the cells apart, and ran the same trial twice
 * under two arm names. That is worse than a crash: the run finishes, the report compares
 * two identical arms, and the difference it reports is noise. A varied axis that nobody
 * applies is refused here instead, before a trial starts.
 */

import type { ExecutionBackend, HarnessCapabilities, Variant, VariantAxis } from "./contracts";

/**
 * How an operator names each axis, so a refusal points at the input that caused it. Every
 * member of `VariantAxis` appears here or the table fails to type, and `VARIANT_AXES` is
 * read off these keys so the list and the union cannot drift apart.
 */
export const VARIANT_AXIS_LABEL: Readonly<Record<VariantAxis, string>> = {
	config: "--config",
	promptVariant: "--prompts",
	attachments: "the attachments axis",
};

/** Axes a variant carries beyond the harness and the model, each needing an applier. */
export const VARIANT_AXES: readonly VariantAxis[] = Object.keys(VARIANT_AXIS_LABEL) as VariantAxis[];

/**
 * The harness capability an axis needs, or null when the axis asks nothing of the harness.
 * A config overlay is settings the backend hands the agent, so every harness takes one.
 */
export const VARIANT_AXIS_CAPABILITY: Readonly<Record<VariantAxis, keyof HarnessCapabilities | null>> = {
	config: null,
	promptVariant: "promptOverrides",
	attachments: "armAttachments",
};

/** Reads one axis off a variant, `null` meaning the variant does not vary that axis. */
export function variantAxisValue(variant: Variant, axis: VariantAxis): string | null {
	switch (axis) {
		case "config":
			return variant.configPath;
		case "promptVariant":
			return variant.promptVariantPath;
		case "attachments":
			return variant.attachments.length > 0 ? variant.attachments.join(",") : null;
	}
}

/** Every axis at least one variant sets, in `VARIANT_AXES` order. */
export function variedAxes(variants: readonly Variant[]): VariantAxis[] {
	return VARIANT_AXES.filter(axis => variants.some(variant => variantAxisValue(variant, axis) !== null));
}

/** Whose declaration refused the axis: the backend that never reads it, or the harness. */
export type VariantAxisHolder = "backend" | "harness";

export class UnappliedVariantAxisError extends Error {
	readonly axis: VariantAxis;
	readonly holder: VariantAxisHolder;
	readonly holderName: string;
	readonly variant: string;

	constructor(axis: VariantAxis, holder: VariantAxisHolder, holderName: string, variant: string) {
		super(
			`${VARIANT_AXIS_LABEL[axis]} is set for variant "${variant}", and ${holder} ${holderName} does not apply it, ` +
				`so every variant of that axis would run the same trial under a different name.`,
		);
		this.name = "UnappliedVariantAxisError";
		this.axis = axis;
		this.holder = holder;
		this.holderName = holderName;
		this.variant = variant;
	}
}

/** What a caller must supply to answer the question for one run. */
export interface VariantSupportQuery {
	readonly backendId: string;
	readonly backendAxes: readonly VariantAxis[];
	readonly variants: readonly Variant[];
	/** Capabilities of each harness named by a variant, keyed by harness name. */
	readonly harnessCapabilities: Readonly<Record<string, HarnessCapabilities>>;
}

/**
 * Every axis this run varies and cannot apply, in `VARIANT_AXES` order then variant order.
 * The backend is named first when it drops the axis outright, since a harness capability
 * cannot rescue a path the backend never reads.
 */
export function checkVariantSupport(query: VariantSupportQuery): UnappliedVariantAxisError[] {
	const problems: UnappliedVariantAxisError[] = [];
	for (const axis of VARIANT_AXES) {
		const backendApplies = query.backendAxes.includes(axis);
		const capability = VARIANT_AXIS_CAPABILITY[axis];
		for (const variant of query.variants) {
			if (variantAxisValue(variant, axis) === null) continue;
			if (!backendApplies) {
				problems.push(new UnappliedVariantAxisError(axis, "backend", query.backendId, variant.name));
				continue;
			}
			if (capability === null) continue;
			if (query.harnessCapabilities[variant.harness]?.[capability] !== true) {
				problems.push(new UnappliedVariantAxisError(axis, "harness", variant.harness, variant.name));
			}
		}
	}
	return problems;
}

/** Throws the first problem `checkVariantSupport` finds. */
export function requireVariantSupport(query: VariantSupportQuery): void {
	const problem = checkVariantSupport(query)[0];
	if (problem) throw problem;
}

/**
 * Builds the query from a backend and the harness registry, so a caller states the run
 * rather than restating what each backend and harness declares.
 */
export function variantSupportQuery(
	backend: ExecutionBackend,
	variants: readonly Variant[],
	capabilitiesOf: (harness: string) => HarnessCapabilities,
): VariantSupportQuery {
	const harnessCapabilities: Record<string, HarnessCapabilities> = {};
	for (const variant of variants) {
		if (!(variant.harness in harnessCapabilities)) {
			harnessCapabilities[variant.harness] = capabilitiesOf(variant.harness);
		}
	}
	return {
		backendId: backend.id,
		backendAxes: backend.appliesVariantAxes,
		variants,
		harnessCapabilities,
	};
}
