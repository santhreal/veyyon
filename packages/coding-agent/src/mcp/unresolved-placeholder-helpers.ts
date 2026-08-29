import { UNRESOLVED_ENV_REFERENCE } from "../discovery/env-expansion";
import type { MCPServerConfig } from "./types";

export const PLACEHOLDER_CHECKED_FIELDS = ["command", "args", "cwd", "url", "envPassthrough"] as const;

export const PLACEHOLDER_DELEGATED_FIELDS = ["env", "headers", "auth", "oauth"] as const;

export const PLACEHOLDER_TRANSPORT_SELECTOR_FIELDS = ["type"] as const;

export interface UnresolvedPlaceholder {
	field: string;
	variable: string;
}

export function findUnresolvedPlaceholder(config: MCPServerConfig): UnresolvedPlaceholder | undefined {
	const record = config as unknown as Record<string, unknown>;
	for (const field of PLACEHOLDER_CHECKED_FIELDS) {
		const value = record[field];
		if (typeof value === "string") {
			const match = UNRESOLVED_ENV_REFERENCE.exec(value);
			if (match) return { field, variable: match[1] };
			continue;
		}
		if (!Array.isArray(value)) continue;
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			if (typeof item !== "string") continue;
			const match = UNRESOLVED_ENV_REFERENCE.exec(item);
			if (match) return { field: `${field}[${index}]`, variable: match[1] };
		}
	}
	return undefined;
}
