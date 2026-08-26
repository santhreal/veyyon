/**
 * Variant matrix expansion and deterministic naming.
 *
 * Expands a selection over four axes (harness × config × prompt variant × model)
 * into a list of Variant records with stable ordering and collision prevention.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import type { Variant } from "./types";

export class VariantMatrixError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VariantMatrixError";
	}
}

export class EmptyAxisError extends VariantMatrixError {
	readonly axis: string;

	constructor(axis: string) {
		super(`Cannot expand variant matrix with empty axis "${axis}".`);
		this.name = "EmptyAxisError";
		this.axis = axis;
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

	return base;
}

/**
 * Expands a multi-axis selection into a deterministic list of Variant objects.
 *
 * @throws {EmptyAxisError} if any required axis is empty.
 * @throws {DuplicateVariantNameError} if any two cells resolve to the same variant name.
 */
export function expandVariantMatrix(selection: VariantMatrixSelection): Variant[] {
	if (!selection.harnesses || selection.harnesses.length === 0) {
		throw new EmptyAxisError("harnesses");
	}
	if (!selection.models || selection.models.length === 0) {
		throw new EmptyAxisError("models");
	}
	if (selection.configs !== undefined && selection.configs.length === 0) {
		throw new EmptyAxisError("configs");
	}
	if (selection.promptVariants !== undefined && selection.promptVariants.length === 0) {
		throw new EmptyAxisError("promptVariants");
	}

	const rawConfigs = selection.configs && selection.configs.length > 0 ? selection.configs : [null];
	const rawPromptVariants =
		selection.promptVariants && selection.promptVariants.length > 0 ? selection.promptVariants : [null];

	const normalizedConfigs = rawConfigs.map(normalizeConfig);
	const normalizedPromptVariants = rawPromptVariants.map(normalizePromptVariant);

	const variants: Variant[] = [];
	const seenNames = new Set<string>();

	let cellIndex = 0;
	for (const harness of selection.harnesses) {
		for (const config of normalizedConfigs) {
			for (const promptVariant of normalizedPromptVariants) {
				for (const model of selection.models) {
					let attachments: readonly string[] = [];
					if (Array.isArray(selection.attachments)) {
						if (selection.attachments.length > 0 && Array.isArray(selection.attachments[0])) {
							const list2d = selection.attachments as readonly (readonly string[])[];
							attachments = list2d[cellIndex % list2d.length] ?? [];
						} else {
							attachments = selection.attachments as readonly string[];
						}
					}

					const cellInput: VariantCellInput = {
						harness,
						config,
						promptVariant,
						model,
						attachments,
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
						harness,
						configPath: config?.path ?? null,
						promptVariantPath: promptVariant?.path ?? null,
						model,
						attachments,
					});

					cellIndex++;
				}
			}
		}
	}

	return variants;
}
