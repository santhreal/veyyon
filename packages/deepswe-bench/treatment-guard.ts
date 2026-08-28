import { modelAllowed } from "argot";

export function encodeArmModelMismatch(config: unknown, model: string): string[] | null {
	if (typeof config !== "object" || config === null) return null;
	const argotBlock = (config as Record<string, unknown>).argot;
	if (typeof argotBlock !== "object" || argotBlock === null) return null;
	const block = argotBlock as Record<string, unknown>;
	if (block.enabled !== true) return null;
	const models = block.models;
	if (!Array.isArray(models) || models.length === 0) return null;
	const allowlist = models.map(entry => String(entry));
	if (allowlist.some(entry => modelAllowed(entry, model))) return null;
	return allowlist;
}

export function isEncodeArm(config: unknown): boolean {
	if (typeof config !== "object" || config === null) return false;
	const argotBlock = (config as Record<string, unknown>).argot;
	if (typeof argotBlock !== "object" || argotBlock === null) return false;
	const block = argotBlock as Record<string, unknown>;
	if (block.enabled !== true) return false;
	const models = block.models;
	return Array.isArray(models) && models.length > 0;
}

export function encodePreambleSilentlyDropped(preambleFlags: readonly (boolean | null)[]): boolean {
	const known = preambleFlags.filter((f): f is boolean => f !== null);
	return known.length > 0 && known.every(f => f === false);
}

export function unknownArmSettings(config: unknown, isKnownPath: (path: string) => boolean): string[] {
	const unknown: string[] = [];
	const walk = (node: unknown, prefix: string): void => {
		const isMapping = node !== null && typeof node === "object" && !Array.isArray(node);
		if (!isMapping) {
			if (prefix !== "") unknown.push(prefix);
			return;
		}
		const entries = Object.entries(node as Record<string, unknown>);
		if (entries.length === 0) {
			if (prefix !== "") unknown.push(prefix);
			return;
		}
		for (const [key, value] of entries) {
			const path = prefix === "" ? key : `${prefix}.${key}`;
			if (isKnownPath(path)) continue;
			walk(value, path);
		}
	};
	walk(config, "");
	return unknown.sort();
}

export interface ArmSettingType {
	readonly kind: string;
	readonly values?: readonly string[];
}

export interface MistypedArmSetting {
	readonly path: string;
	readonly expected: string;
	readonly actual: string;
}

export function mistypedArmSettings(
	config: unknown,
	typeOf: (path: string) => ArmSettingType | undefined,
): MistypedArmSetting[] {
	const problems: MistypedArmSetting[] = [];
	const walk = (node: unknown, prefix: string): void => {
		const declared = prefix === "" ? undefined : typeOf(prefix);
		if (declared !== undefined) {
			const problem = describeMismatch(declared, node);
			if (problem !== undefined) problems.push({ path: prefix, ...problem });
			return;
		}
		if (node === null || typeof node !== "object" || Array.isArray(node)) return;
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			walk(value, prefix === "" ? key : `${prefix}.${key}`);
		}
	};
	walk(config, "");
	return problems.sort((a, b) => a.path.localeCompare(b.path));
}

function describeMismatch(declared: ArmSettingType, value: unknown): Omit<MistypedArmSetting, "path"> | undefined {
	const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
	switch (declared.kind) {
		case "boolean":
			return actual === "boolean" ? undefined : { expected: "boolean", actual };
		case "number":
			return typeof value === "number" && Number.isFinite(value) ? undefined : { expected: "number", actual };
		case "string":
			return actual === "string" ? undefined : { expected: "string", actual };
		case "enum": {
			const allowed = declared.values ?? [];
			if (typeof value === "string" && allowed.includes(value)) return undefined;
			return {
				expected: `one of ${allowed.join(", ")}`,
				actual: actual === "string" ? `"${String(value)}"` : actual,
			};
		}
		case "array":
			return Array.isArray(value) ? undefined : { expected: "array", actual };
		case "record":
			return value !== null && typeof value === "object" && !Array.isArray(value)
				? undefined
				: { expected: "record", actual };
		default:
			return undefined;
	}
}
