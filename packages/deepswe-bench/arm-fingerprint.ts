import { createHash } from "node:crypto";
import { ARM_ATTACHMENT_SUFFIXES } from "./arm-attachments";

export interface ArmInputs {
	readonly config: unknown;
	readonly sections?: unknown;
	readonly statements?: unknown;
	readonly prompts?: unknown;
	readonly rule?: Uint8Array;
}

export function canonicalizeConfig(value: unknown): string {
	return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.keys(record)
				.sort()
				.map(key => [key, sortDeep(record[key])]),
		);
	}
	return value;
}

export { ARM_ATTACHMENT_SUFFIXES };

export function isArmConfigFile(name: string): boolean {
	return name.endsWith(".yml") && !ARM_ATTACHMENT_SUFFIXES.some(suffix => name.endsWith(suffix));
}

export function armNamesIn(files: readonly string[]): string[] {
	return files
		.filter(isArmConfigFile)
		.map(name => name.slice(0, -".yml".length))
		.sort();
}

export function armSelectionError(arm: string, available: readonly string[]): string | null {
	const attachment = ARM_ATTACHMENT_SUFFIXES.find(suffix => `${arm}.yml`.endsWith(suffix));
	if (attachment !== undefined) {
		const real = arm.slice(0, -(attachment.length - ".yml".length));
		return (
			`"${arm}" is not an arm, it is the ${attachment} attachment of arm "${real}".\n` +
			`Fix: bench the arm itself (--arms ${real}); its ${attachment} is applied automatically.`
		);
	}
	if (!available.includes(arm)) {
		return `no arm "${arm}" in arms/.\nAvailable arms: ${available.join(", ")}`;
	}
	return null;
}

export function computeArmFingerprint(mod: ArmInputs): string {
	const h = createHash("sha256");
	const field = (label: string, bytes: Uint8Array): void => {
		h.update(`${label}:${bytes.length}\n`);
		h.update(bytes);
	};
	field("config", new TextEncoder().encode(canonicalizeConfig(mod.config)));
	field("sections", new TextEncoder().encode(canonicalizeConfig(mod.sections ?? {})));
	const statements = canonicalizeConfig(mod.statements ?? {});
	if (statements !== "{}") field("statements", new TextEncoder().encode(statements));
	const prompts = canonicalizeConfig(mod.prompts ?? {});
	if (prompts !== "{}") field("prompts", new TextEncoder().encode(prompts));
	if (mod.rule !== undefined) field("rule", mod.rule);
	return h.digest("hex");
}

export function findZeroIvCollisions(fingerprints: Map<string, string>): string[][] {
	const byPrint = new Map<string, string[]>();
	for (const [arm, fp] of fingerprints) {
		const group = byPrint.get(fp);
		if (group) group.push(arm);
		else byPrint.set(fp, [arm]);
	}
	return [...byPrint.values()].filter(group => group.length > 1);
}
