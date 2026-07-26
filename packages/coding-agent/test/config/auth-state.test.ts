import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { isAuthenticated, kNoAuth } from "@veyyon/coding-agent/config/auth-state";

const AUTH_STATE = path.join(import.meta.dir, "../../src/config/auth-state.ts");

/**
 * `kNoAuth` and `isAuthenticated` decide whether a provider is usable. They are
 * three lines, they are called from the registry, the resolver, the SDK, the
 * token command and image generation, and until 2026-07-25 they lived inside
 * `config/model-registry.ts`, which made the registry and the resolver a mutual
 * import pair. Both halves are covered here: the behaviour, which is what every
 * caller depends on, and the module's emptiness, which is what keeps the cycle
 * from coming back.
 */
describe("isAuthenticated", () => {
	/**
	 * The ordinary case. A stored key means the provider is configured, and the
	 * predicate narrows to `string` so callers can use the key straight after the
	 * check rather than asserting it a second time.
	 */
	it("accepts a real credential", () => {
		expect(isAuthenticated("sk-ant-0123456789")).toBe(true);
	});

	/**
	 * The two shapes of "no credential recorded". `undefined` is a provider that
	 * was never configured; `null` is one whose lookup ran and found nothing.
	 * Neither may pass, and both reach here because the storage layer returns one
	 * or the other depending on which path missed.
	 */
	it.each([
		["undefined", undefined],
		["null", null],
	])("rejects %s", (_label, value) => {
		expect(isAuthenticated(value)).toBe(false);
	});

	/**
	 * The reason the sentinel exists. A local provider needs a stored value, or
	 * "keyless on purpose" would be indistinguishable from "never configured". The
	 * value it stores must still not count as a credential, because there is no key
	 * behind it to send.
	 */
	it("rejects the keyless sentinel", () => {
		expect(isAuthenticated(kNoAuth)).toBe(false);
	});

	/**
	 * The empty string is falsy, so it fails on the first clause rather than the
	 * sentinel comparison. Worth pinning separately: a rewrite to
	 * `apiKey != null && apiKey !== kNoAuth` would still pass every case above and
	 * would start treating an empty key as authenticated, which sends an empty
	 * Authorization header to the provider and fails at the wire instead of here.
	 */
	it("rejects the empty string", () => {
		expect(isAuthenticated("")).toBe(false);
	});

	/**
	 * Adversarial: the sentinel comparison is exact, not a case-insensitive or
	 * trimmed match. A user who genuinely typed one of these into their config
	 * meant it as a key, and silently reading it as "keyless" would disable a
	 * provider they configured, with nothing printed to say why.
	 */
	it.each(["n/a", "N/a", "n/A", " N/A", "N/A ", "N/A/", "NA"])(
		"treats %p as a real credential, not the sentinel",
		(value: string) => {
			// Annotated `string` rather than inferred: the inferred type is the literal
			// union of the seven cases, which lets the compiler prove the comparison
			// false and reject it as unintentional. The comparison is the point, so the
			// type is widened to the type a config file actually produces.
			expect(value === kNoAuth).toBe(false);
			expect(isAuthenticated(value)).toBe(true);
		},
	);

	/**
	 * The sentinel's exact value is a stored contract, not an implementation
	 * detail. It is already written into every user's provider config on disk, so
	 * changing the string would silently re-authenticate every keyless provider:
	 * the old value would stop matching, `isAuthenticated` would start returning
	 * true, and a request would go out with `N/A` as the credential.
	 */
	it("pins the sentinel value that is already on disk", () => {
		expect(kNoAuth).toBe("N/A");
	});
});

describe("config/auth-state has no dependencies", () => {
	/**
	 * The point of the module. It exists so `model-resolver` can test a credential
	 * without importing `model-registry`, which imports the resolver back. Any
	 * import added here re-couples both sides to whatever it pulls in, and the
	 * first one would look harmless. Importing the resolver reached 149 modules
	 * while the pair existed and reaches 7 now, so this is the line holding that.
	 *
	 * Read as text rather than through the module graph: this must fail on a `type`
	 * import too. A type-only edge costs nothing at runtime and the cycle test
	 * ignores it by design, but it is how the first real import arrives, one `type`
	 * keyword getting dropped later.
	 */
	it("imports nothing at all", () => {
		const source = fs.readFileSync(AUTH_STATE, "utf8");
		const imports = source.match(/(?:^|\n)[ \t]*(?:import|export)\b[^\n]*\bfrom\b[^\n]*/g) ?? [];
		const sideEffectImports = source.match(/(?:^|\n)[ \t]*import\s+["'][^"']+["']/g) ?? [];

		expect([...imports, ...sideEffectImports]).toEqual([]);
	});

	/**
	 * Anti-vacuity for the case above: prove the file was actually read and that
	 * the pattern finds an import when one is present. Without this, an empty or
	 * renamed file would pass by matching nothing.
	 */
	it("reads the real file, and the pattern does match imports", () => {
		const source = fs.readFileSync(AUTH_STATE, "utf8");

		expect(source).toContain("export const kNoAuth");
		expect(source).toContain("export function isAuthenticated");
		expect(`\nimport { x } from "./y";`.match(/(?:^|\n)[ \t]*(?:import|export)\b[^\n]*\bfrom\b[^\n]*/g)).toHaveLength(
			1,
		);
	});
});
