/**
 * Variant matrix expansion and deterministic naming.
 *
 * Expands a selection across the axes declared in `VARIANT_MATRIX_AXES` — harness, config, prompt
 * variant and model — into a list of Variant records with stable ordering and collision prevention.
 * The suite axis is expanded outside this matrix, once per suite, because a suite carries its own
 * task list and backend. Adding an axis is a row in that table, not an edit to the expansion.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Variant } from "./contracts";

export class VariantMatrixError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VariantMatrixError";
	}
}

/** English, not `${axis}s`: the plural of corpus is corpora, and a message that says "corpuss" reads as a bug. */
export const AXIS_PLURAL: Readonly<Record<string, string>> = {
	harnesses: "harnesses",
	configs: "configs",
	promptVariants: "prompt variants",
	models: "models",
	attachments: "attachment sets",
	corpus: "corpora",
	corpora: "corpora",
	suite: "suites",
	suites: "suites",
};

export class EmptyAxisError extends VariantMatrixError {
	readonly axis: string;
	readonly plural: string;

	constructor(axis: string, plural?: string) {
		const resolvedPlural = plural ?? (axis in AXIS_PLURAL ? AXIS_PLURAL[axis] : axis);
		super(`Cannot expand variant matrix with empty axis "${axis}". No ${resolvedPlural} selected.`);
		this.name = "EmptyAxisError";
		this.axis = axis;
		this.plural = resolvedPlural;
	}
}

export class DuplicateVariantNameError extends VariantMatrixError {
	readonly variantName: string;

	constructor(variantName: string) {
		super(
			`Duplicate resolved variant name "${variantName}". Each cell in the variant matrix must produce a unique name.`,
		);
		this.name = "DuplicateVariantNameError";
		this.variantName = variantName;
	}
}

export interface ConfigSpec {
	readonly name?: string | null;
	readonly path: string | null;
	readonly config?: unknown;
}

export interface PromptVariantSpec {
	readonly name?: string | null;
	readonly path: string | null;
	readonly overrides?: unknown;
}

export interface VariantCellInput {
	readonly harness: string;
	readonly config: ConfigSpec | null;
	readonly promptVariant: PromptVariantSpec | null;
	readonly model: string;
	readonly attachments: readonly string[];
}

export type MutableVariantCellInput = {
	harness: string;
	config: ConfigSpec | null;
	promptVariant: PromptVariantSpec | null;
	model: string;
	attachments: readonly string[];
	[key: string]: unknown;
};

export interface AxisDescriptor<TRaw = unknown, TNormalized = unknown> {
	readonly id: string;
	readonly plural: string;
	readonly select: (selection: VariantMatrixSelection) => readonly TRaw[] | undefined;
	readonly defaultValues?: readonly TRaw[];
	readonly normalize: (item: TRaw) => TNormalized;
	readonly project: (cell: MutableVariantCellInput, value: TNormalized) => void;
}

export interface VariantMatrixSelection {
	readonly harnesses: readonly string[];
	readonly configs?: readonly (string | ConfigSpec | null)[];
	readonly promptVariants?: readonly (string | PromptVariantSpec | null)[];
	readonly models: readonly string[];
	readonly attachments?: readonly string[] | readonly (readonly string[])[];
	readonly nameFormatter?: (cell: VariantCellInput) => string;
}

export interface VariantInputs {
	readonly config?: unknown;
	readonly sections?: unknown;
	readonly statements?: unknown;
	readonly prompts?: unknown;
	readonly rule?: Uint8Array;
}

/**
 * Sort object keys deeply for stable canonical JSON stringification.
 */
function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortDeep);
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const sortedEntries = Object.keys(record)
			.sort()
			.map(key => [key, sortDeep(record[key])]);
		return Object.fromEntries(sortedEntries);
	}
	return value;
}

/**
 * Stable, key-sorted JSON representation of arbitrary config values.
 */
export function canonicalizeConfig(value: unknown): string {
	return JSON.stringify(sortDeep(value));
}

/**
 * Computes a deterministic content fingerprint for an arm / variant input set.
 * Uses length-prefixed hashing for injective encoding.
 */
export function computeVariantFingerprint(inputs: VariantInputs): string {
	const hash = createHash("sha256");
	const updateField = (label: string, bytes: Uint8Array): void => {
		hash.update(`${label}:${bytes.length}\n`);
		hash.update(bytes);
	};

	const encoder = new TextEncoder();
	updateField("config", encoder.encode(canonicalizeConfig(inputs.config ?? {})));

	const sections = canonicalizeConfig(inputs.sections ?? {});
	if (sections !== "{}") {
		updateField("sections", encoder.encode(sections));
	}

	const statements = canonicalizeConfig(inputs.statements ?? {});
	if (statements !== "{}") {
		updateField("statements", encoder.encode(statements));
	}

	const prompts = canonicalizeConfig(inputs.prompts ?? {});
	if (prompts !== "{}") {
		updateField("prompts", encoder.encode(prompts));
	}

	if (inputs.rule !== undefined) {
		updateField("rule", inputs.rule);
	}

	return hash.digest("hex");
}

/**
 * Finds groups of variants that share identical input fingerprints (0 independent variables).
 */
export function findVariantCollisions(fingerprints: ReadonlyMap<string, string>): string[][] {
	const byFingerprint = new Map<string, string[]>();
	for (const [name, fp] of fingerprints) {
		const existing = byFingerprint.get(fp);
		if (existing) {
			existing.push(name);
		} else {
			byFingerprint.set(fp, [name]);
		}
	}
	return [...byFingerprint.values()].filter(group => group.length > 1);
}

function cleanBaseName(filePath: string): string {
	const base = path.basename(filePath);
	const dotIndex = base.indexOf(".");
	return dotIndex > 0 ? base.slice(0, dotIndex) : base;
}

function normalizeConfig(item: string | ConfigSpec | null): ConfigSpec | null {
	if (item === null) return null;
	if (typeof item === "string") {
		const isPath = item.includes("/") || item.includes("\\") || item.endsWith(".yml") || item.endsWith(".yaml");
		return {
			name: isPath ? cleanBaseName(item) : item,
			path: item,
		};
	}
	return {
		name: item.name ?? (item.path ? cleanBaseName(item.path) : null),
		path: item.path,
		config: item.config,
	};
}

function normalizePromptVariant(item: string | PromptVariantSpec | null): PromptVariantSpec | null {
	if (item === null) return null;
	if (typeof item === "string") {
		const isPath = item.includes("/") || item.includes("\\") || item.endsWith(".yml") || item.endsWith(".yaml");
		return {
			name: isPath ? cleanBaseName(item) : item,
			path: item,
		};
	}
	return {
		name: item.name ?? (item.path ? cleanBaseName(item.path) : null),
		path: item.path,
		overrides: item.overrides,
	};
}

/**
 * One attachment set per cell, from either spelling of the selection: a flat list is the same set
 * for every cell, a list of lists is one axis value per set. An absent or empty selection is the
 * single empty set.
 */
export function attachmentSets(
	selection: VariantMatrixSelection["attachments"],
): readonly (readonly string[])[] | undefined {
	if (!Array.isArray(selection)) return undefined;
	if (selection.length === 0) return [[]];
	if (Array.isArray(selection[0])) return selection as readonly (readonly string[])[];
	return [selection as readonly string[]];
}

/** The name segment an attachment set contributes: its file base names, or `none` for the empty set. */
export function attachmentLabel(values: readonly string[]): string {
	return values.length === 0 ? "none" : values.map(value => cleanBaseName(value)).join("+");
}

export const VARIANT_MATRIX_AXES: readonly AxisDescriptor<unknown, unknown>[] = [
	{
		id: "harnesses",
		plural: AXIS_PLURAL.harnesses ?? "harnesses",
		select: (selection: VariantMatrixSelection) => selection.harnesses,
		normalize: (harness: unknown) => harness as string,
		project: (cell: MutableVariantCellInput, value: unknown) => {
			cell.harness = value as string;
		},
	},
	{
		id: "configs",
		plural: AXIS_PLURAL.configs ?? "configs",
		select: (selection: VariantMatrixSelection) => selection.configs,
		defaultValues: [null],
		normalize: (config: unknown) => normalizeConfig(config as string | ConfigSpec | null),
		project: (cell: MutableVariantCellInput, value: unknown) => {
			cell.config = value as ConfigSpec | null;
		},
	},
	{
		id: "promptVariants",
		plural: AXIS_PLURAL.promptVariants ?? "prompt variants",
		select: (selection: VariantMatrixSelection) => selection.promptVariants,
		defaultValues: [null],
		normalize: (promptVariant: unknown) => normalizePromptVariant(promptVariant as string | PromptVariantSpec | null),
		project: (cell: MutableVariantCellInput, value: unknown) => {
			cell.promptVariant = value as PromptVariantSpec | null;
		},
	},
	{
		id: "models",
		plural: AXIS_PLURAL.models ?? "models",
		select: (selection: VariantMatrixSelection) => selection.models,
		normalize: (model: unknown) => model as string,
		project: (cell: MutableVariantCellInput, value: unknown) => {
			cell.model = value as string;
		},
	},
	{
		id: "attachments",
		plural: AXIS_PLURAL.attachments ?? "attachment sets",
		select: (selection: VariantMatrixSelection) => attachmentSets(selection.attachments),
		defaultValues: [[]],
		normalize: (values: unknown) => values as readonly string[],
		project: (cell: MutableVariantCellInput, value: unknown) => {
			cell.attachments = value as readonly string[];
		},
	},
];

/**
 * Computes generic cartesian product across arrays of arbitrary elements.
 */
export function cartesianProduct<T>(arrays: readonly (readonly T[])[]): T[][] {
	if (arrays.length === 0) return [];
	return arrays.reduce<T[][]>((acc, curr) => acc.flatMap(prefix => curr.map(item => [...prefix, item])), [[]]);
}

/**
 * Default deterministic variant name generator.
 */
function defaultVariantName(cell: VariantCellInput, selection: VariantMatrixSelection): string {
	const configName = cell.config?.name ?? null;
	const promptName = cell.promptVariant?.name ?? null;

	let base: string;
	if (configName) {
		base = selection.harnesses.length > 1 ? `${cell.harness}:${configName}` : configName;
	} else {
		base = cell.harness;
	}

	if (promptName) {
		base = `${base}+${promptName}`;
	}

	if (selection.models.length > 1) {
		base = `${base}@${cell.model}`;
	}

	// An attachment set is an axis: two sets are two arms, and the name has to say which is which or
	// the run reports one set's result under the other's name.
	const sets = attachmentSets(selection.attachments);
	if (sets && sets.length > 1) {
		base = `${base}~${attachmentLabel(cell.attachments)}`;
	}

	return base;
}

/**
 * Expands a multi-axis selection into a deterministic list of Variant objects.
 *
 * @throws {EmptyAxisError} if any required axis is empty.
 * @throws {DuplicateVariantNameError} if any two cells resolve to the same variant name.
 */
export function expandVariantMatrix(
	selection: VariantMatrixSelection,
	axes: readonly AxisDescriptor<unknown, unknown>[] = VARIANT_MATRIX_AXES,
): Variant[] {
	const normalizedAxes: (readonly unknown[])[] = [];

	for (const axis of axes) {
		const raw = axis.select(selection);
		if (raw !== undefined && raw.length === 0) {
			throw new EmptyAxisError(axis.id, axis.plural);
		}
		const values = raw ?? axis.defaultValues;
		if (!values || values.length === 0) {
			throw new EmptyAxisError(axis.id, axis.plural);
		}
		normalizedAxes.push(values.map(item => axis.normalize(item)));
	}

	const product = cartesianProduct(normalizedAxes);
	const variants: Variant[] = [];
	const seenNames = new Set<string>();

	for (const row of product) {
		const cell: MutableVariantCellInput = {
			harness: "",
			config: null,
			promptVariant: null,
			model: "",
			attachments: [],
		};

		for (let axisIndex = 0; axisIndex < axes.length; axisIndex++) {
			axes[axisIndex].project(cell, row[axisIndex]);
		}

		const cellInput: VariantCellInput = {
			...cell,
		};

		const name = selection.nameFormatter
			? selection.nameFormatter(cellInput)
			: defaultVariantName(cellInput, selection);

		if (seenNames.has(name)) {
			throw new DuplicateVariantNameError(name);
		}
		seenNames.add(name);

		variants.push({
			name,
			harness: cellInput.harness,
			configPath: cellInput.config?.path ?? null,
			promptVariantPath: cellInput.promptVariant?.path ?? null,
			model: cellInput.model,
			attachments: cellInput.attachments,
		});
	}

	return variants;
}
