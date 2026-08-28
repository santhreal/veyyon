/** The last stop for a `${VAR}` that nothing resolved. A discovered MCP config is expanded once at load time (`expandEnvVarsDeep` in */

import { UNRESOLVED_ENV_REFERENCE } from "../discovery/env-expansion";
import { describeMCPServerTarget } from "./transports/transport-failure";
import type { MCPServerConfig } from "./types";

/** Config fields scanned for an unresolved placeholder, each named as it appears in the config file. All five hold structure rather than secret material: an executable, its arguments, a directory, a */
export const PLACEHOLDER_CHECKED_FIELDS = ["command", "args", "cwd", "url", "envPassthrough"] as const;

/** Fields not scanned, because their strings are resolved credential material and a real secret may contain the characters `${`. */
export const PLACEHOLDER_DELEGATED_FIELDS = ["env", "headers", "auth", "oauth"] as const;

/** `type` selects the transport, so a placeholder in it is neither scanned nor delegated: it matches no transport and `createTransport` rejects it by name before this scan would matter. */
export const PLACEHOLDER_TRANSPORT_SELECTOR_FIELDS = ["type"] as const;

/** An unresolved placeholder, named by the field it sits in and the variable it asks for. */
export interface UnresolvedPlaceholder {
	/** Config field, `args[2]` for an array element. */
	field: string;
	/** Variable name inside the placeholder. */
	variable: string;
}

/**
 * The first unresolved placeholder in a field that becomes a process or a hostname, or undefined.
 */
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

/** Raised instead of spawning or dialling a server whose config still names an unset variable. */
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

/** Throw when a field that becomes a process or a hostname still names an unset variable. Called before a transport exists, so a rejected config has spawned nothing and opened no socket. */
export function assertNoUnresolvedPlaceholder(config: MCPServerConfig): void {
	const found = findUnresolvedPlaceholder(config);
	if (!found) return;
	throw new MCPUnresolvedPlaceholderError({
		field: found.field,
		variable: found.variable,
		target: describeMCPServerTarget(config),
	});
}
