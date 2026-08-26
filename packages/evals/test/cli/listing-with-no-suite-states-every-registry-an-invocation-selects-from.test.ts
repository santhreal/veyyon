/**
 * WHY: `--list` documented itself as listing "suites, backends and harnesses" and printed
 * only suites, from the `builtinSuites` literal rather than from the registry. Two axes of
 * the five had no discovery path at all: an operator learned the harness names from the
 * source, and a suite registered from outside this package was invisible to the listing
 * that was supposed to enumerate it.
 *
 * The class this closes: a listing that states less than the registries hold. The rows are
 * built from the arrays handed in, so a member registered by anything — this package, an
 * extension, a test — is listed by the same call, and the sweep below reads the real
 * registries at run time rather than a recorded name list, so a fourth harness or a second
 * in-process backend appears without editing this file.
 *
 * What it does not catch: whether a listed harness can actually start a trial on the
 * backend it names (its preflight verdict, which `--dry-run` reports), and the
 * per-suite task listing, which `--list --suite <name>` produces and which the
 * task-scoping suite covers.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { describeRegistries, main } from "../../src/cli";
import { listBackendIds } from "../../src/core/backend-registry";
import { listHarnessNames } from "../../src/core/harness-registry";
import { listSuiteNames } from "../../src/core/suite-registry";
import type { BackendId, HarnessAdapter } from "../../src/core/types";

type ListedSuite = Parameters<typeof describeRegistries>[0][number];
type ListedHarness = Parameters<typeof describeRegistries>[2][number];

function harness(name: string, defaultModel: string | null, backends: readonly BackendId[]): ListedHarness {
	const bound: Record<string, HarnessAdapter["backends"][BackendId]> = {};
	for (const id of backends) bound[id] = {};
	return { name, defaultModel, backends: bound };
}

describe("the listing of a registry", () => {
	const suites: ListedSuite[] = [
		{ name: "zebra-suite", backend: "in-process", description: "last by name, first registered" },
		{ name: "alpha-suite", backend: "pier", description: "first by name, last registered" },
	];

	it("lists a member this package does not ship", () => {
		const text = describeRegistries(
			[{ name: "extension-suite", backend: "modal", description: "registered elsewhere" }],
			["modal"],
			[harness("extension-harness", "vendor/model-1", ["modal"])],
		);
		expect(text).toContain("extension-suite");
		expect(text).toContain("  modal");
		expect(text).toContain("extension-harness");
		expect(text).toContain("vendor/model-1");
	});

	it("orders each section by name, whatever order the registry returns", () => {
		const text = describeRegistries(
			suites,
			["pier", "in-process"],
			[harness("omp", "vendor/b", ["pier"]), harness("factory", "vendor/a", ["pier"])],
		);
		const backendSection = text.slice(text.indexOf("backends (id):"), text.indexOf("harnesses ("));
		expect(text.indexOf("alpha-suite")).toBeLessThan(text.indexOf("zebra-suite"));
		expect(backendSection.indexOf("in-process")).toBeLessThan(backendSection.indexOf("pier"));
		expect(text.indexOf("factory")).toBeLessThan(text.indexOf("omp"));
	});

	it("states that a harness without a default model needs one on the command line", () => {
		const text = describeRegistries([], [], [harness("veyyon", null, ["harbor"])]);
		expect(text).toContain("--model required");
	});

	it("names a harness that binds no backend rather than printing a blank column", () => {
		const text = describeRegistries([], [], [harness("unbound", "vendor/model", [])]);
		expect(text).toContain("unbound");
		expect(text).toContain("none");
	});

	it("lists every backend a harness binds, so an unreachable pairing is visible before a run", () => {
		const text = describeRegistries([], [], [harness("veyyon", null, ["pier", "harbor", "in-process"])]);
		expect(text).toContain("harbor, in-process, pier");
	});

	it("pads each column to its widest cell, so a long model id shifts the whole column", () => {
		const text = describeRegistries(
			[],
			[],
			[harness("a", "short/id", ["pier"]), harness("bbbb", "a-considerably-longer/model-id", ["harbor"])],
		);
		expect(text).toContain(
			["  a     short/id                        pier", "  bbbb  a-considerably-longer/model-id  harbor"].join("\n"),
		);
	});
});

describe("`evals --list` with no suite", () => {
	const written: string[] = [];

	afterEach(() => {
		written.length = 0;
	});

	async function listOutput(): Promise<string> {
		const write = spyOn(process.stdout, "write").mockImplementation((chunk: unknown): boolean => {
			written.push(String(chunk));
			return true;
		});
		try {
			expect(await main(["--list"])).toBe(0);
		} finally {
			write.mockRestore();
		}
		return written.join("");
	}

	it("states every registered suite, backend and harness", async () => {
		const text = await listOutput();

		// Swept from the registries the CLI itself populated: a new member is covered here
		// the moment it registers, and a member the listing drops turns this red.
		expect(listSuiteNames().length).toBeGreaterThan(0);
		expect(listBackendIds().length).toBeGreaterThan(0);
		expect(listHarnessNames().length).toBeGreaterThan(0);
		for (const name of listSuiteNames()) expect(text).toContain(name);
		for (const id of listBackendIds()) expect(text).toContain(id);
		for (const name of listHarnessNames()) expect(text).toContain(name);

		expect(text).toContain("suites (name, backend, description):");
		expect(text).toContain("backends (id):");
		expect(text).toContain("harnesses (name, default model, backends it binds):");
	});
});
