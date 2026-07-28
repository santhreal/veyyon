/**
 * What `vibe/runtime` publishes, and what it deliberately keeps to itself.
 *
 * WHY THIS SUITE EXISTS. The module exported three names that no other file
 * imported: `VIBE_CLI_AGENT` (the CLI-flavor to agent-type mapping), the
 * `VibeTurnError` a turn job throws, and the `VibeSpawnOutcome` shape. An export
 * with no importer is not free. It is a promise: the next reader takes it as a
 * supported entry point, and the module then has to keep it working from the
 * outside as well as the inside.
 *
 * Two of them are now file-private. The mapping is read once, by `spawn`, and its
 * whole point is that agent resolution goes through `spawn` rather than around
 * it; a second caller reading the mapping directly is exactly the drift that
 * comment warns about. The error is thrown and caught inside the module and
 * appears in no signature, so a `catch` outside would be reaching into how a turn
 * reports failure.
 *
 * `VibeSpawnOutcome` stays exported, and the difference is the point of this
 * suite: `spawn` is a public method of an exported class, so that name is part of
 * the declaration this package publishes (`tsconfig.publish.json` emits `.d.ts`),
 * and a caller holding the result in a typed binding needs it. Un-exporting it
 * would be tidier by name count and wrong by contract.
 *
 * The behavior underneath is covered by `vibe-runtime.test.ts`, whose spawn cases
 * still resolve agent names through the now-private mapping. This suite asserts
 * only the surface.
 */
import { describe, expect, it } from "bun:test";
// The type import is itself an assertion: it fails `check:ts` if the interface
// stops being exported, which is the half a runtime key check cannot see because
// an interface leaves nothing behind at runtime.
import type { VibeSpawnOutcome } from "@veyyon/coding-agent/vibe/runtime";

const MODULE = "@veyyon/coding-agent/vibe/runtime";

describe("vibe/runtime export surface", () => {
	/**
	 * The two internal names are gone from the module's runtime exports.
	 *
	 * Asserted against the loaded module rather than against source text, so it
	 * holds however the export is written (`export const`, a trailing `export {}`
	 * list, a re-export).
	 */
	it("does not export the CLI-to-agent mapping or the turn error", async () => {
		const runtime = await import(MODULE);
		const keys = Object.keys(runtime);

		expect(keys, "the mapping is read once by spawn and belongs to this file").not.toContain("VIBE_CLI_AGENT");
		expect(keys, "the turn error is thrown and caught inside this module").not.toContain("VibeTurnError");
		expect("VIBE_CLI_AGENT" in runtime).toBe(false);
		expect("VibeTurnError" in runtime).toBe(false);
	});

	/**
	 * NON-VACUITY: the import really loaded the module.
	 *
	 * Without this, the absences above are satisfied by an empty namespace, which
	 * is what a moved or renamed module would produce.
	 */
	it("still exports the registry the module exists for", async () => {
		const runtime = await import(MODULE);

		expect(typeof runtime.VibeSessionRegistry).toBe("function");
		expect(Object.keys(runtime).length).toBeGreaterThan(0);
	});

	/**
	 * And the published shape is still nameable by a caller.
	 *
	 * The value below is typed by the imported interface, so this test does not
	 * compile if `VibeSpawnOutcome` becomes private, and it pins the two fields a
	 * caller reads off a spawn.
	 */
	it("exports the spawn outcome shape, which a public method returns", () => {
		const outcome: VibeSpawnOutcome = { id: "worker-1", jobId: "job-1" };

		expect(outcome.id).toBe("worker-1");
		expect(outcome.jobId).toBe("job-1");
	});

	/**
	 * Nothing outside the module reaches for the private names.
	 *
	 * A source scan, because an import of a private name is caught by the
	 * typechecker only while the name stays private: re-exporting it to satisfy a
	 * new caller compiles and passes, and puts the surface back where it was.
	 */
	it("has no importer anywhere in the package for either private name", async () => {
		const glob = new Bun.Glob("**/*.{ts,tsx}");
		const root = new URL("../../", import.meta.url).pathname;
		const offenders: string[] = [];
		let scanned = 0;

		for await (const rel of glob.scan({ cwd: root, onlyFiles: true })) {
			if (rel.startsWith("node_modules/") || rel.startsWith("dist/")) continue;
			if (rel === "src/vibe/runtime.ts" || rel.endsWith("vibe-runtime-export-surface.test.ts")) continue;
			const text = await Bun.file(`${root}${rel}`).text();
			scanned += 1;
			if (/\bVIBE_CLI_AGENT\b|\bVibeTurnError\b/.test(text)) offenders.push(rel);
		}

		// NON-VACUITY: the walk really covered the package.
		expect(scanned).toBeGreaterThan(500);
		expect(offenders, "these names are file-private; route through spawn and the outcome types").toEqual([]);
	});
});
