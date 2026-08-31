/**
 * WHY: a harness reaches a run through two things it declares — the backends it binds
 * and the agent each binding names. This suite used to read the four adapter modules off
 * disk and assert on their source text, so a binding could be renamed, emptied or
 * silently dropped and the suite stayed green as long as the file still mentioned the
 * word. The plumbing it did check (`typeof harness.preflight === "function"`) is what
 * TypeScript already proves.
 *
 * The class this closes: a registered harness whose bindings cannot start a trial. Every
 * assertion sweeps `harnesses.list()` at run time, so a fifth harness is covered the
 * moment it registers, and the registered set is pinned by equality: adding one turns
 * this red until its bindings are recorded here.
 *
 * What it does not catch: whether the agent an import path names exists in the container
 * (proved by the python agent suites), and whether a preflight verdict is correct for a
 * host that has the tooling installed — here every builtin is preflighted against a host
 * that may lack it, so only the verdict's shape and its refusal contract are asserted.
 */

import { describe, expect, it } from "bun:test";
import { requireBackendBinding } from "../../engine/cell-variant";
import type { BackendId } from "../../engine/contracts";
import { harnesses } from "../../engine/loaded-members";
import { factoryAdapter } from "../../harnesses/factory";
import { hermesAdapter } from "../../harnesses/hermes";
import { ompAdapter } from "../../harnesses/omp";
import { veyyonAdapter } from "../../harnesses/veyyon";

/**
 * The bindings each shipped harness is expected to declare. Pinned by exact equality so
 * a harness that gains or loses a backend has to record the change here.
 */
const EXPECTED_BINDINGS: Readonly<Record<string, readonly BackendId[]>> = {
	veyyon: ["pier", "harbor", "in-process"],
	omp: ["pier", "harbor"],
	factory: ["pier"],
	hermes: ["pier"],
};

/** The adapter object each name must resolve to: the shipped module, not a copy of it. */
const SHIPPED_ADAPTERS = {
	veyyon: veyyonAdapter,
	omp: ompAdapter,
	factory: factoryAdapter,
	hermes: hermesAdapter,
} as const;

describe("the registered harnesses", () => {
	it("is exactly the shipped set, so a new harness records its bindings here", () => {
		expect([...harnesses.ids()].sort()).toEqual(Object.keys(EXPECTED_BINDINGS).sort());
	});

	it("resolves each harness by the name it states, so a rename cannot orphan it", () => {
		for (const name of harnesses.ids()) {
			expect(harnesses.require(name).id).toBe(name);
		}
	});

	it("resolves each name to the adapter module that ships it, so no second instance can drift", () => {
		for (const [name, adapter] of Object.entries(SHIPPED_ADAPTERS)) {
			expect(harnesses.require(name)).toBe(adapter);
		}
		expect(Object.keys(SHIPPED_ADAPTERS).sort()).toEqual([...harnesses.ids()].sort());
	});

	it("declares the backends recorded for it, and no others", () => {
		for (const harness of harnesses.list()) {
			expect(Object.keys(harness.backends).sort()).toEqual([...EXPECTED_BINDINGS[harness.id]].sort());
		}
	});
});

describe("a binding a run can start a trial from", () => {
	it("names an agent import path and an absolute container assets directory for every pier binding", () => {
		for (const harness of harnesses.list()) {
			const binding = requireBackendBinding(harness, "pier");
			expect(binding.agentImportPath).toMatch(/^\w[\w.]*:\w+$/);
			expect(binding.containerAssetsDir?.startsWith("/")).toBe(true);
		}
	});

	it("rejects a backend the harness does not bind, naming the backends it does", () => {
		const pierOnly = harnesses.list().find(harness => EXPECTED_BINDINGS[harness.id].length === 1);
		if (!pierOnly) throw new Error("expected at least one pier-only harness");

		expect(() => requireBackendBinding(pierOnly, "harbor")).toThrow(
			new RegExp(`Harness "${pierOnly.id}" declares no binding for backend "harbor".*Bound backends: pier`),
		);
	});

	it("routes the veyyon harbor binding to the local agent under the harbor agent name", () => {
		const veyyon = harnesses.require("veyyon");
		const harbor = requireBackendBinding(veyyon, "harbor");

		expect(harbor.agentImportPath).toBe("veyyon_local:VeyyonLocal");
		expect(harbor.agentName).toBe("veyyon");
		expect(requireBackendBinding(veyyon, "pier").agentImportPath).toBe("veyyon_agent:VeyyonAgent");
	});

	it("states no default model for veyyon, so a run that names none is refused rather than guessed", () => {
		expect(harnesses.require("veyyon").defaultModel).toBeNull();
	});
});

describe("preflighting a harness against this host", () => {
	it("returns a verdict that names what is missing whenever it refuses", async () => {
		for (const harness of harnesses.list()) {
			const verdict = await harness.preflight({ backend: "pier" });
			if (verdict.ok) continue;
			expect(verdict.missingRequirements?.length ?? 0).toBeGreaterThan(0);
			expect(verdict.reason).toBeTruthy();
		}
	});
});
