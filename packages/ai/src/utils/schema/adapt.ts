import { $flag } from "@veyyon/utils/env";
import { upgradeJsonSchemaTo202012 } from "./draft";
import { tryEnforceStrictSchema } from "./normalize";

export const NO_STRICT = $flag("VEYYON_NO_STRICT");

export function adaptSchemaForStrict(
	schema: Record<string, unknown>,
	strict: boolean,
): { schema: Record<string, unknown>; strict: boolean } {
	const upgraded = upgradeJsonSchemaTo202012(schema) as Record<string, unknown>;
	if (!strict) {
		return { schema: upgraded, strict: false };
	}

	return tryEnforceStrictSchema(upgraded);
}
