/**
 * WHY: the harbor backend hardcoded the `veyyon` harness and its `agent/veyyon.txt`
 * log path in multiple places, preventing other harness adapters from running on
 * harbor even though the harness registry modeled backend bindings. A harness with
 * no harbor binding was either silently assumed to be veyyon or broke with an opaque
 * failure.
 *
 * The class this closes: execution backends bypassing the harness registry and
 * hardcoding one specific agent or log path. The registry sweep asserts that every
 * harness declaring a harbor binding produces an agent name and log path, that any
 * harness lacking a harbor binding is rejected by name listing available harbor-capable
 * harnesses, and that the exported helper is the single authority on log path shape.
 *
 * What it does not catch: container-internal behavior of a third-party agent runner
 * inside the harbor task container.
 */

import { describe, expect, it } from "bun:test";
import {
	HarborBindingNotFoundError,
	harborAgentLogPath,
	requireHarborBinding,
} from "../../src/backends/harbor/backend";
import { buildHarborArgs } from "../../src/backends/harbor/launch-args";
import { buildHarborEnv, type Config } from "../../src/backends/harbor/runner/config";
import { listHarnesses, requireHarness } from "../../src/core/harness-registry";
import type { HarnessAdapter, HarnessCapabilities, PreflightVerdict } from "../../src/core/types";
import { registerBuiltinHarnesses } from "../../src/harnesses/index";

registerBuiltinHarnesses();

describe("a harbor harness resolves its agent name and log path from the registry", () => {
	it("every harness declaring a harbor binding produces a resolvable agent name and log path", () => {
		const allHarnesses = listHarnesses();
		expect(allHarnesses.length).toBeGreaterThan(0);

		const harborBound = allHarnesses.filter(h => Boolean(h.backends.harbor));
		expect(harborBound.length).toBeGreaterThanOrEqual(1);

		for (const harness of harborBound) {
			const binding = requireHarborBinding(harness);
			expect(binding).toBeDefined();
			expect(typeof binding.agentName).toBe("string");
			expect(binding.agentName!.trim().length).toBeGreaterThan(0);

			const logPathFromHarness = harborAgentLogPath(harness);
			expect(logPathFromHarness).toBe(`agent/${binding.agentName}.txt`);

			const logPathFromName = harborAgentLogPath(binding.agentName!);
			expect(logPathFromName).toBe(`agent/${binding.agentName}.txt`);
		}
	});

	it("a harness without a harbor binding is rejected by name with harbor-capable ids", () => {
		const allHarnesses = listHarnesses();
		const unbound = allHarnesses.filter(h => !h.backends.harbor);
		expect(unbound.length).toBeGreaterThan(0);

		const harborCapableNames = allHarnesses.filter(h => Boolean(h.backends.harbor)).map(h => h.name);

		for (const harness of unbound) {
			expect(() => requireHarborBinding(harness)).toThrow(HarborBindingNotFoundError);

			try {
				requireHarborBinding(harness);
				expect.unreachable("requireHarborBinding should have thrown");
			} catch (err) {
				expect(err).toBeInstanceOf(HarborBindingNotFoundError);
				const error = err as HarborBindingNotFoundError;
				expect(error.name).toBe("HarborBindingNotFoundError");
				expect(error.harnessName).toBe(harness.name);
				expect(error.message).toContain(harness.name);
				for (const capableId of harborCapableNames) {
					expect(error.message).toContain(capableId);
				}
				expect(error.harborCapableHarnesses).toEqual(expect.arrayContaining(harborCapableNames));
			}
		}
	});

	it("the log-path helper is the single producer of agent/<name>.txt", () => {
		expect(harborAgentLogPath("veyyon")).toBe("agent/veyyon.txt");
		expect(harborAgentLogPath("oracle")).toBe("agent/oracle.txt");
		expect(harborAgentLogPath("nop")).toBe("agent/nop.txt");
		expect(harborAgentLogPath("custom_agent")).toBe("agent/custom_agent.txt");

		const veyyon = requireHarness("veyyon");
		expect(harborAgentLogPath(veyyon)).toBe("agent/veyyon.txt");
	});

	it("adding a harness with a harbor binding and no agent name turns the validation red", () => {
		const emptyCapabilities: HarnessCapabilities = {
			replay: false,
			compaction: false,
			armAttachments: false,
			promptOverrides: false,
		};

		const invalidHarness: HarnessAdapter = {
			name: "invalid-harbor-agent",
			displayName: "Invalid Harbor Agent",
			description: "Harness with an empty harbor binding",
			defaultModel: null,
			capabilities: emptyCapabilities,
			backends: {
				harbor: {
					agentName: "",
				},
			},
			async preflight(): Promise<PreflightVerdict> {
				return { ok: true };
			},
			async stageAssets(): Promise<void> {},
		};

		expect(() => requireHarborBinding(invalidHarness)).toThrow(/declares a harbor backend binding with no agentName/);

		const missingAgentNameHarness: HarnessAdapter = {
			name: "missing-agent-name",
			displayName: "Missing Agent Name",
			description: "Harness with undefined agentName in harbor binding",
			defaultModel: null,
			capabilities: emptyCapabilities,
			backends: {
				harbor: {},
			},
			async preflight(): Promise<PreflightVerdict> {
				return { ok: true };
			},
			async stageAssets(): Promise<void> {},
		};

		expect(() => requireHarborBinding(missingAgentNameHarness)).toThrow(
			/declares a harbor backend binding with no agentName/,
		);
	});

	it("buildHarborArgs resolves agent import path or name from the harness registry", () => {
		const veyyonArgs = buildHarborArgs({
			jobsDir: "/runs/jobs",
			jobName: "job-veyyon",
			agent: "veyyon",
		});
		expect(veyyonArgs).toContain("--agent-import-path");
		expect(veyyonArgs).toContain("veyyon_local:VeyyonLocal");

		const oracleArgs = buildHarborArgs({
			jobsDir: "/runs/jobs",
			jobName: "job-oracle",
			agent: "oracle",
		});
		expect(oracleArgs).toContain("-a");
		expect(oracleArgs).toContain("oracle");
		expect(oracleArgs).not.toContain("--agent-import-path");
	});

	it("buildHarborEnv produces agent env only for harbor-bound harnesses", () => {
		const mockConfig: Config = {
			agent: "veyyon",
			install: "source",
			version: null,
			tarball: null,
			thinking: null,
			agentArgs: ["--flag"],
			webSearch: false,
			gateway: true,
			gatewayUrl: "http://127.0.0.1:4000",
			gatewayToken: "token-1",
			envType: "docker" as const,
			env: {},
			models: ["test/model"],
			tasks: 1,
			dataset: "ds",
			concurrency: 1,
			attempts: 1,
			jobsDir: "/runs",
			jobName: "j1",
			build: false,
			dryRun: false,
			cleanup: false,
			cleanupForce: false,
			hostNetwork: false,
			resume: null,
			filterErrorTypes: [],
			passthrough: [],
			binaryArm64: null,
			binaryX64: null,
			providers: [],
			include: [],
			exclude: [],
			allowHosts: [],
			timeoutMultiplier: 1,
			yes: false,
		};

		const env = buildHarborEnv(mockConfig, "/path/to/models.yaml", null, "1.0.0");
		expect(env.VEYYON_BENCH_INSTALL).toBe("source");
		expect(env.VEYYON_BENCH_AGENT_ARGS).toBe('["--flag"]');
		expect(env.VEYYON_BENCH_GATEWAY).toBe("1");

		const unboundEnv = buildHarborEnv({ ...mockConfig, agent: "omp" }, "/path/to/models.yaml", null, "1.0.0");
		expect(unboundEnv.VEYYON_BENCH_INSTALL).toBeUndefined();
		expect(unboundEnv.VEYYON_BENCH_AGENT_ARGS).toBeUndefined();
		expect(unboundEnv.VEYYON_BENCH_GATEWAY).toBeUndefined();
	});
});
