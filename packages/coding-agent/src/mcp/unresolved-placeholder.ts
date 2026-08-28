import { UNRESOLVED_ENV_REFERENCE } from "../discovery/env-expansion";
import { describeMCPServerTarget } from "./transports/transport-failure";
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

export class MCPUnresolvedPlaceholderError extends Error {
	readonly field: string;
	readonly variable: string;

	constructor(details: { field: string; variable: string; target: string }) {
		super(
			`The ${details.field} for ${details.target} still contains \${${details.variable}}, because that environment variable is not set, so the server was not started rather than run with a variable name in place of the value. Fix: export ${details.variable}, or write a default in the config as \${${details.variable}:-value}.`,
		);
		this.name = "MCPUnresolvedPlaceholderError";
		this.field = details.field;
		this.variable = details.variable;
	}
}

export function assertNoUnresolvedPlaceholder(config: MCPServerConfig): void {
	const found = findUnresolvedPlaceholder(config);
	if (!found) return;
	throw new MCPUnresolvedPlaceholderError({
		field: found.field,
		variable: found.variable,
		target: describeMCPServerTarget(config),
	});
}
