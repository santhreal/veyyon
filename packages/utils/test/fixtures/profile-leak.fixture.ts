/**
 * Leaves a named profile active, restoring every environment variable it touched.
 *
 * Used by `scripts/find-test-leaks.test.ts` to prove the tracer sees MODULE state,
 * not only the environment: `setProfile` records the active profile in module
 * state, so putting the variables back leaves every later file resolving under
 * `profiles/leaky/` while an env-only snapshot reports nothing.
 */
import { expect, it } from "bun:test";
import { getActiveProfile, setProfile } from "../../src/dirs";

it("activates a profile and never returns to the default", () => {
	setProfile("leaky");
	expect(getActiveProfile()).toBe("leaky");
});
