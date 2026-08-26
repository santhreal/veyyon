/**
 * Tests for EvalSuite, HarnessAdapter, and ExecutionBackend registries.
 *
 * Enforces dynamic enumeration of members from source/registry at run time,
 * proving that lookup, listing, duplicate rejection, and unknown-member
 * error reporting behave predictably without hardcoding member lists.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	BackendNotFoundError,
	BackendRegistry,
	DuplicateBackendRegistrationError,
	getBackend,
	hasBackend,
	listBackendIds,
	listBackends,
	registerBackend,
	requireBackend,
	unregisterBackend,
} from "../../src/core/backend-registry";
import {
	DuplicateHarnessRegistrationError,
	getHarness,
	HarnessNotFoundError,
	HarnessRegistry,
	hasHarness,
	listHarnesses,
	listHarnessNames,
	registerHarness,
	requireHarness,
	unregisterHarness,
} from "../../src/core/harness-registry";
import {
	DuplicateSuiteRegistrationError,
	getSuite,
	hasSuite,
	listSuiteNames,
	listSuites,
	registerSuite,
	requireSuite,
	SuiteNotFoundError,
	SuiteRegistry,
	unregisterSuite,
} from "../../src/core/suite-registry";
import type { EvalSuite, ExecutionBackend, HarnessAdapter } from "../../src/core/types";

function createMockSuite(name: string): EvalSuite {
	return {
		name,
		version: "1.0.0",
		displayName: `Suite ${name}`,
		description: `Test suite for ${name}`,
		backend: "pier",
		async discoverTasks() {
			return ["task-1", "task-2"];
		},
		async describeTask(taskId: string) {
			return {
				id: taskId,
				path: null,
				timeBudgetSec: 60,
				instructionPath: null,
				metadata: {},
			};
		},
		async provenance() {
			return {
				suite: name,
				version: "1.0.0",
				sha: "sha-123",
			};
		},
		async scoreTrial(cell) {
			return {
				reward: 1,
				partial: null,
				error: null,
				usage: null,
				extra: { cell },
			};
		},
		async preflight() {
			return { ok: true };
		},
	};
}

function createMockHarness(name: string): HarnessAdapter {
	return {
		name,
		displayName: `Harness ${name}`,
		description: `Test harness for ${name}`,
		flags: [],
		defaultModel: "anthropic/claude-3-7-sonnet",
		capabilities: {
			armAttachments: true,
			compaction: true,
		},
		backends: {
			pier: {
				agentImportPath: "mock_agent:MockAgent",
			},
		},
		async preflight() {
			return { ok: true };
		},
		async stageAssets() {},
	};
}

function createMockBackend(id: string): ExecutionBackend {
	return {
		id,
		async preflight() {
			return { ok: true };
		},
		async prepare() {},
		async runTrial(cell) {
			return {
				logPaths: [`/logs/${cell.task}.log`],
				trialDir: `/tmp/trials/${cell.task}`,
			};
		},
		async cleanup() {},
	};
}

/**
 * The default registries are shared process-wide and the real suites, harnesses and
 * backends register themselves when their modules load. Clearing a default registry
 * here would empty it for every test file that runs after this one in the same bun
 * process, which is exactly how `harborBackend` went missing from
 * `defaultBackendRegistry`. So these tests add probe members under names nothing
 * real uses, and remove exactly those.
 */
describe("SuiteRegistry", () => {
	const probes = ["probe-suite-alpha", "probe-suite-beta"] as const;

	afterEach(() => {
		for (const name of probes) unregisterSuite(name);
	});

	it("registers suites and retrieves them via default registry helpers", () => {
		const suiteA = createMockSuite(probes[0]);
		const suiteB = createMockSuite(probes[1]);
		const before = listSuiteNames().length;

		registerSuite(suiteA);
		registerSuite(suiteB);

		expect(hasSuite(probes[0])).toBe(true);
		expect(hasSuite(probes[1])).toBe(true);
		expect(hasSuite("probe-suite-gamma")).toBe(false);

		expect(getSuite(probes[0])).toBe(suiteA);
		expect(getSuite(probes[1])).toBe(suiteB);
		expect(getSuite("probe-suite-gamma")).toBeUndefined();

		expect(requireSuite(probes[0])).toBe(suiteA);
		expect(requireSuite(probes[1])).toBe(suiteB);

		expect(listSuites().length).toBe(before + 2);
		expect(listSuiteNames().slice(-2)).toEqual([probes[0], probes[1]]);
	});

	it("rejects duplicate suite registration with a typed error", () => {
		const registry = new SuiteRegistry();
		const suite = createMockSuite("deep-swe");

		registry.register(suite);
		expect(() => registry.register(suite)).toThrow(DuplicateSuiteRegistrationError);
		expect(() => registry.register(suite)).toThrow(/already registered/);
	});

	it("throws SuiteNotFoundError naming all available registered suites", () => {
		const registry = new SuiteRegistry();
		registry.register(createMockSuite("suite-1"));
		registry.register(createMockSuite("suite-2"));

		let caught: unknown = null;
		try {
			registry.require("non-existent");
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(SuiteNotFoundError);
		expect((caught as Error).message).toContain("non-existent");
		expect((caught as Error).message).toContain("suite-1, suite-2");
	});

	it("sweeps registered suites dynamically at runtime without hardcoded lists", () => {
		const registry = new SuiteRegistry();
		const testNames = ["dynamic-a", "dynamic-b", "dynamic-c"];

		for (const name of testNames) {
			registry.register(createMockSuite(name));
		}

		const namesFromRegistry = registry.listNames();
		expect(namesFromRegistry.length).toBe(testNames.length);

		for (const name of namesFromRegistry) {
			expect(registry.has(name)).toBe(true);
			const resolved = registry.require(name);
			expect(resolved.name).toBe(name);
		}

		const unregisteredProbe = "unregistered-probe-suite";
		expect(() => registry.require(unregisteredProbe)).toThrow(SuiteNotFoundError);
	});
});

describe("HarnessRegistry", () => {
	const probes = ["probe-harness-one", "probe-harness-two"] as const;

	afterEach(() => {
		for (const name of probes) unregisterHarness(name);
	});

	it("registers harnesses and retrieves them via default registry helpers", () => {
		const h1 = createMockHarness(probes[0]);
		const h2 = createMockHarness(probes[1]);

		registerHarness(h1);
		registerHarness(h2);

		expect(hasHarness(probes[0])).toBe(true);
		expect(hasHarness(probes[1])).toBe(true);
		expect(hasHarness("probe-harness-absent")).toBe(false);

		expect(getHarness(probes[0])).toBe(h1);
		expect(requireHarness(probes[1])).toBe(h2);
		expect(listHarnesses().slice(-2)).toEqual([h1, h2]);
		expect(listHarnessNames().slice(-2)).toEqual([probes[0], probes[1]]);
	});

	it("rejects duplicate harness registration", () => {
		const registry = new HarnessRegistry();
		const h = createMockHarness("veyyon");

		registry.register(h);
		expect(() => registry.register(h)).toThrow(DuplicateHarnessRegistrationError);
	});

	it("throws HarnessNotFoundError listing registered harnesses on missing member", () => {
		const registry = new HarnessRegistry();
		registry.register(createMockHarness("veyyon"));
		registry.register(createMockHarness("factory"));

		expect(() => registry.require("unknown-harness")).toThrow(HarnessNotFoundError);
		expect(() => registry.require("unknown-harness")).toThrow(/veyyon, factory/);
	});

	it("sweeps registered harnesses dynamically at runtime", () => {
		const registry = new HarnessRegistry();
		const sampleNames = ["h-1", "h-2", "h-3", "h-4"];

		for (const name of sampleNames) {
			registry.register(createMockHarness(name));
		}

		const enumerated = registry.list();
		expect(enumerated.length).toBe(sampleNames.length);

		for (const item of enumerated) {
			expect(registry.require(item.name)).toBe(item);
		}

		expect(() => registry.require("missing-harness")).toThrow(HarnessNotFoundError);
	});
});

describe("BackendRegistry", () => {
	const probes = ["probe-backend-one", "probe-backend-two"] as const;

	afterEach(() => {
		for (const id of probes) unregisterBackend(id);
	});

	it("registers backends and retrieves them via default registry helpers", () => {
		const b1 = createMockBackend(probes[0]);
		const b2 = createMockBackend(probes[1]);

		registerBackend(b1);
		registerBackend(b2);

		expect(hasBackend(probes[0])).toBe(true);
		expect(hasBackend(probes[1])).toBe(true);
		expect(hasBackend("probe-backend-absent")).toBe(false);

		expect(getBackend(probes[0])).toBe(b1);
		expect(requireBackend(probes[1])).toBe(b2);
		expect(listBackends().slice(-2)).toEqual([b1, b2]);
		expect(listBackendIds().slice(-2)).toEqual([probes[0], probes[1]]);
	});

	it("rejects duplicate backend registration", () => {
		const registry = new BackendRegistry();
		const b = createMockBackend("pier");

		registry.register(b);
		expect(() => registry.register(b)).toThrow(DuplicateBackendRegistrationError);
	});

	it("throws BackendNotFoundError listing registered backends on missing backend", () => {
		const registry = new BackendRegistry();
		registry.register(createMockBackend("pier"));
		registry.register(createMockBackend("harbor"));

		expect(() => registry.require("in-process")).toThrow(BackendNotFoundError);
		expect(() => registry.require("in-process")).toThrow(/pier, harbor/);
	});

	it("sweeps registered backends dynamically at runtime", () => {
		const registry = new BackendRegistry();
		const sampleBackends = ["b-alpha", "b-beta", "b-gamma"];

		for (const id of sampleBackends) {
			registry.register(createMockBackend(id));
		}

		const ids = registry.listIds();
		expect(ids.length).toBe(sampleBackends.length);

		for (const id of ids) {
			expect(registry.require(id).id).toBe(id);
		}

		expect(() => registry.require("unregistered-backend")).toThrow(BackendNotFoundError);
	});
});
