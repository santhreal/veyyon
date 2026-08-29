import { describeMCPServerTarget } from "./transports/transport-failure";
import type { MCPServerConfig } from "./types";

import { findUnresolvedPlaceholder } from "./unresolved-placeholder-helpers";

export {
	PLACEHOLDER_CHECKED_FIELDS,
	PLACEHOLDER_DELEGATED_FIELDS,
	PLACEHOLDER_TRANSPORT_SELECTOR_FIELDS,
} from "./unresolved-placeholder-helpers";
export { findUnresolvedPlaceholder };

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
