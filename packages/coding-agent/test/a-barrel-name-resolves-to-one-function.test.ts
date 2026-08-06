/**
 * A name the package root exports means one thing.
 *
 * WHY THIS SUITE EXISTS. `src/index.ts` mixes `export *` with explicit named
 * re-exports, and an explicit name silently wins over a star that offers the
 * same one. That is not an error, a warning, or anything a type check reports:
 * the barrel compiles, both modules keep their own definition, and the name
 * resolves to whichever line happened to be explicit.
 *
 * `discoverSlashCommands` was the case in the tree. `sdk.ts` defines it, and
 * `docs/sdk.md` and `examples/sdk/README.md` both name it as the discovery
 * helper to import from the package root. The barrel also carried
 * `export { loadSlashCommands as discoverSlashCommands }`, which is a DIFFERENT
 * function with a different signature, and the alias won. Every reader
 * following the documentation got the other one, and got a plausible-looking
 * array back, so nothing pointed at the barrel.
 *
 * Identity is the only assertion that can see this. Both spellings return a
 * `FileSlashCommand[]`, so a shape check, a length check, or "it is a function"
 * all pass in the broken world.
 */
import { describe, expect, it } from "bun:test";
import * as barrel from "@veyyon/coding-agent";
import { loadSlashCommands } from "@veyyon/coding-agent/extensibility/slash-commands";
import * as sdk from "@veyyon/coding-agent/sdk";

describe("the package root exports the sdk's discovery helper", () => {
	it("resolves discoverSlashCommands to the sdk function, not the loader it wraps", () => {
		expect(barrel.discoverSlashCommands).toBe(sdk.discoverSlashCommands);
		expect(barrel.discoverSlashCommands).not.toBe(loadSlashCommands);
	});

	it("still carries the type that helper returns, so the star is not a partial re-export", () => {
		// A value-level anchor for a type-only export: `FileSlashCommand` came in
		// on the deleted alias line and now arrives through `export * from
		// "./sdk"`. If that star stopped covering it the import below stops
		// compiling, which is the failure this case exists to convert into a
		// named test rather than a mystery error in a consumer's build.
		const command: barrel.FileSlashCommand = {
			name: "demo",
			description: "a command",
			content: "hello",
			source: "project",
		};

		expect(command.name).toBe("demo");
	});
});
