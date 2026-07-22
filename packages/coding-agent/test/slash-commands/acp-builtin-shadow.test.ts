import { describe, expect, it } from "bun:test";
import { ACP_BUILTIN_RESERVED_NAMES, isAcpBuiltinShadowedName } from "@veyyon/coding-agent/slash-commands/acp-builtins";

/**
 * isAcpBuiltinShadowedName gates whether an extension slash command is advertised to ACP
 * clients: a name that a builtin would capture at dispatch must be hidden, or the palette
 * shows the extension command while the builtin runs instead. It had no test. The subtle
 * case is the colon prefix: parseSlashCommand treats `:` as a name/args separator, so
 * `model:foo` runs the `/model` builtin. Pinned so a regression cannot start advertising a
 * shadowed name:
 *   - an exact reserved name (primary or alias) is shadowed;
 *   - a `reserved:suffix` name is shadowed by its prefix;
 *   - a name whose prefix is NOT reserved is not shadowed.
 */

describe("isAcpBuiltinShadowedName", () => {
	it("shadows an exact reserved primary name and a reserved alias", () => {
		// `model` is a builtin; `models` is its alias — both are reserved.
		expect(ACP_BUILTIN_RESERVED_NAMES.has("model")).toBe(true);
		expect(ACP_BUILTIN_RESERVED_NAMES.has("models")).toBe(true);
		expect(isAcpBuiltinShadowedName("model")).toBe(true);
		expect(isAcpBuiltinShadowedName("models")).toBe(true);
	});

	it("shadows a colon-namespaced name whose prefix is a reserved builtin", () => {
		expect(isAcpBuiltinShadowedName("model:foo")).toBe(true);
	});

	it("does not shadow a name (or colon-prefixed name) whose prefix is unreserved", () => {
		expect(ACP_BUILTIN_RESERVED_NAMES.has("zzz-not-a-builtin-xyz")).toBe(false);
		expect(isAcpBuiltinShadowedName("zzz-not-a-builtin-xyz")).toBe(false);
		expect(isAcpBuiltinShadowedName("zzznope:foo")).toBe(false);
	});
});
