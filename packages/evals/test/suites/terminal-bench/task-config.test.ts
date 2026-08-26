import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
	loadTaskConfig,
	parseTaskConfig,
	serializeTaskConfig,
	type TaskArtifactConfig,
	type TaskConfig,
} from "../../../src/suites/terminal-bench/task-config";

const FIXTURES_ROOT = resolve(import.meta.dirname, "fixtures");
const TASKS_ROOT = join(FIXTURES_ROOT, "tasks");

describe("task-config parsing and validation", () => {
	test("parses gpu-task fixture with complete GPU properties", async () => {
		const config = await loadTaskConfig(join(TASKS_ROOT, "gpu-task"));

		expect(config.schema_version).toBe("1.4");
		expect(config.task?.name).toBe("terminal-bench/gpu-task");
		expect(config.task?.description).toBe("GPU acceleration test task");
		expect(config.task?.authors).toEqual([{ name: "GPU Team", email: "gpu@example.com" }]);
		expect(config.task?.keywords).toEqual(["gpu", "cuda", "h100"]);

		expect(config.metadata.category).toBe("ML");
		expect(config.metadata.tags).toEqual(["gpu", "training"]);
		expect(config.metadata.expert_time_estimate_hours).toBe(4.0);

		// Verifier
		expect(config.verifier.timeout_sec).toBe(1200.0);
		expect(config.verifier.environment_mode).toBe("separate");
		expect(config.verifier.user).toBe("root");
		expect(config.verifier.environment?.gpus).toBe(1);
		expect(config.verifier.environment?.gpu_types).toEqual(["H100"]);
		expect(config.verifier.environment?.cpus).toBe(8);
		expect(config.verifier.environment?.memory_mb).toBe(16384);

		// Agent
		expect(config.agent.timeout_sec).toBe(3600.0);
		expect(config.agent.user).toBe("root");

		// Environment
		expect(config.environment.os).toBe("linux");
		expect(config.environment.cpus).toBe(8);
		expect(config.environment.memory_mb).toBe(16384);
		expect(config.environment.storage_mb).toBe(32768);
		expect(config.environment.gpus).toBe(1);
		expect(config.environment.gpu_types).toEqual(["H100"]);
		expect(config.environment.network_mode).toBe("public");

		// Solution
		expect(config.solution.env).toEqual({ CUDA_VISIBLE_DEVICES: "0" });
		expect(config.artifacts).toEqual(["/app/output/model.pt"]);
	});

	test("parses no-network-task fixture with network isolation", async () => {
		const config = await loadTaskConfig(join(TASKS_ROOT, "no-network-task", "task.toml"));

		expect(config.task?.name).toBe("terminal-bench/no-network-task");
		expect(config.environment.network_mode).toBe("no-network");
		expect(config.agent.network_mode).toBe("no-network");
		expect(config.verifier.network_mode).toBe("no-network");
		expect(config.verifier.environment_mode).toBe("separate");
	});

	test("parses shared-verifier-task fixture", async () => {
		const config = await loadTaskConfig(join(TASKS_ROOT, "shared-verifier-task"));

		expect(config.task?.name).toBe("terminal-bench/shared-verifier-task");
		expect(config.verifier.environment_mode).toBe("shared");
		expect(config.verifier.user).toBe(1000);
		expect(config.agent.user).toBe(1000);
	});

	test("parses complex-task fixture with MCP servers, healthcheck, table artifacts and legacy sizes", async () => {
		const config = await loadTaskConfig(join(TASKS_ROOT, "complex-task"));

		expect(config.task?.name).toBe("terminal-bench/complex-task");
		expect(config.task?.version).toBe("2.1.0");
		expect(config.metadata.author_name).toEqual(["Lead Dev", "Co-Author"]);
		expect(config.metadata.custom_score_weight).toBe(1.25);

		// Artifacts table
		expect(config.artifacts.length).toBe(2);
		const firstArtifact = config.artifacts[0] as TaskArtifactConfig;
		expect(firstArtifact.source).toBe("/app/reports/");
		expect(firstArtifact.destination).toBe("reports");
		expect(firstArtifact.exclude).toEqual(["*.tmp", ".cache"]);
		expect(config.artifacts[1]).toBe("/app/final.json");

		// Healthcheck
		expect(config.environment.healthcheck?.command).toBe("curl -f http://localhost:8080/health");
		expect(config.environment.healthcheck?.interval_sec).toBe(10.0);
		expect(config.environment.healthcheck?.retries).toBe(3);

		// MCP servers
		expect(config.environment.mcp_servers?.length).toBe(1);
		expect(config.environment.mcp_servers?.[0]?.name).toBe("fetcher");
		expect(config.environment.mcp_servers?.[0]?.transport).toBe("stdio");
		expect(config.environment.mcp_servers?.[0]?.env).toEqual({ DEBUG: "true" });

		// Legacy memory "8G" and storage "20480M" converted to MB
		expect(config.environment.memory_mb).toBe(8192);
		expect(config.environment.storage_mb).toBe(20480);

		// Verifier collect
		expect(config.verifier.collect?.length).toBe(1);
		expect(config.verifier.collect?.[0]?.service).toBe("db");
		expect(config.verifier.collect?.[0]?.command).toBe("pg_dump -U postgres test > /tmp/dump.sql");
	});

	test("round-trips GPU, no-network, and shared-verifier tasks", async () => {
		const taskNames = ["gpu-task", "no-network-task", "shared-verifier-task", "complex-task"];

		for (const taskName of taskNames) {
			const original = await loadTaskConfig(join(TASKS_ROOT, taskName));
			const serialized = serializeTaskConfig(original);
			const reparsed = parseTaskConfig(serialized);

			expect(reparsed.schema_version).toBe(original.schema_version);
			expect(reparsed.task?.name).toBe(original.task?.name);
			expect(reparsed.environment.network_mode).toBe(original.environment.network_mode);
			expect(reparsed.environment.os).toBe(original.environment.os);
			expect(reparsed.environment.cpus).toBe(original.environment.cpus);
			expect(reparsed.environment.memory_mb).toBe(original.environment.memory_mb);
			expect(reparsed.environment.gpus).toBe(original.environment.gpus);
			expect(reparsed.verifier.timeout_sec).toBe(original.verifier.timeout_sec);
			expect(reparsed.verifier.environment_mode).toBe(original.verifier.environment_mode);
			expect(reparsed.agent.timeout_sec).toBe(original.agent.timeout_sec);
		}
	});

	test("enumerates all defined TaskConfig properties at runtime", async () => {
		const config = await loadTaskConfig(join(TASKS_ROOT, "complex-task"));

		// Expected top-level keys
		const expectedTopLevelKeys: (keyof TaskConfig)[] = [
			"schema_version",
			"task",
			"metadata",
			"verifier",
			"agent",
			"environment",
			"solution",
			"artifacts",
			"source",
			"multi_step_reward_strategy",
			"steps",
		];

		for (const key of expectedTopLevelKeys) {
			expect(key in config).toBe(true);
		}

		// Verify that all keys on config are in the expected list
		for (const key of Object.keys(config)) {
			expect(expectedTopLevelKeys).toContain(key as keyof TaskConfig);
		}
	});

	test("fails closed on invalid TOML syntax", () => {
		expect(() => parseTaskConfig("this is not valid toml = = =")).toThrow();
	});

	test("fails closed on artifact directory traversal attempt", () => {
		const toml = `
artifacts = ["/app/../../etc/passwd"]
[task]
name = "terminal-bench/hack"
`;
		expect(() => parseTaskConfig(toml)).toThrow(/Artifact source must not contain '\.\.' components/);
	});

	test("fails closed on invalid OS", () => {
		const toml = `
[task]
name = "terminal-bench/bad-os"
[environment]
os = "solaris"
`;
		expect(() => parseTaskConfig(toml)).toThrow(/Invalid OS "solaris"/);
	});

	test("fails closed on invalid network_mode", () => {
		const toml = `
[task]
name = "terminal-bench/bad-net"
[environment]
network_mode = "unrestricted"
`;
		expect(() => parseTaskConfig(toml)).toThrow(/Invalid network_mode "unrestricted"/);
	});

	test("fails closed on invalid verifier environment_mode", () => {
		const toml = `
[task]
name = "terminal-bench/bad-ver"
[verifier]
environment_mode = "isolated-cluster"
`;
		expect(() => parseTaskConfig(toml)).toThrow(/Invalid verifier environment_mode/);
	});

	test("fails closed on invalid size string format", () => {
		const toml = `
[task]
name = "terminal-bench/bad-size"
[environment]
memory = "100Terabytes"
`;
		expect(() => parseTaskConfig(toml)).toThrow(/Invalid size format/);
	});

	test("migrates legacy allow_internet boolean and version alias", () => {
		const toml = `
version = "1.0"
[task]
name = "terminal-bench/legacy"
[environment]
allow_internet = false
`;
		const parsed = parseTaskConfig(toml);
		expect(parsed.schema_version).toBe("1.0");
		expect(parsed.environment.network_mode).toBe("no-network");
	});
});
