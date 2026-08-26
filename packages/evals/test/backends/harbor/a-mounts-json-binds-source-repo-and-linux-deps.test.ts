/**
 * WHY: Harbor containers need access to host source trees and Linux binaries
 * via mounts JSON (for Apple Container) or compose overlay YAML (for Docker).
 * This suite proves that buildMountsJson and writeComposeOverlay construct the
 * exact bind paths required by task containers.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig, SOURCE_BIN_MOUNT, SOURCE_SRC_MOUNT } from "../../../src/backends/harbor/runner/config";
import type { SourceMount } from "../../../src/backends/harbor/runner/deps";
import { buildMountsJson, writeComposeOverlay } from "../../../src/backends/harbor/runner/mounts";
import { repoRootDir } from "../../../src/paths";

describe("a mounts json binds source repo and linux deps", () => {
	let benchDir: string;

	beforeEach(() => {
		benchDir = fs.mkdtempSync(path.join(os.tmpdir(), "mounts-test-"));
	});

	afterEach(() => {
		fs.rmSync(benchDir, { recursive: true, force: true });
	});

	it("returns null when no source mount, host network, or gateway extra-hosts are needed", () => {
		expect(buildMountsJson(null)).toBeNull();
		const cfg = defaultConfig();
		cfg.gateway = false;
		cfg.hostNetwork = false;
		expect(writeComposeOverlay(benchDir, cfg, null)).toBeNull();
	});

	it("builds a mounts JSON array binding the repo root, node_modules, and bin/bun", () => {
		const source: SourceMount = {
			arch: "arm64",
			depsDir: "/var/cache/evals/deps/linux-arm64",
			nodeModules: ["node_modules", "packages/evals/node_modules"],
		};

		const jsonStr = buildMountsJson(source);
		expect(jsonStr).not.toBeNull();
		const mounts = JSON.parse(jsonStr as string);

		expect(mounts).toEqual([
			{ type: "bind", source: repoRootDir(), target: SOURCE_SRC_MOUNT, read_only: true },
			{
				type: "bind",
				source: "/var/cache/evals/deps/linux-arm64/node_modules",
				target: `${SOURCE_SRC_MOUNT}/node_modules`,
				read_only: true,
			},
			{
				type: "bind",
				source: "/var/cache/evals/deps/linux-arm64/packages/evals/node_modules",
				target: `${SOURCE_SRC_MOUNT}/packages/evals/node_modules`,
				read_only: true,
			},
			{
				type: "bind",
				source: "/var/cache/evals/deps/linux-arm64/bin",
				target: SOURCE_BIN_MOUNT,
				read_only: true,
			},
		]);
	});

	it("writes compose overlay YAML with host network and volume binds when configured", () => {
		const cfg = defaultConfig();
		cfg.hostNetwork = true;
		cfg.gateway = true;
		cfg.gatewayUrl = "http://host.docker.internal:4000";

		const source: SourceMount = {
			arch: "x64",
			depsDir: "/tmp/deps/linux-x64",
			nodeModules: ["node_modules"],
		};

		const filePath = writeComposeOverlay(benchDir, cfg, source);
		expect(filePath).not.toBeNull();
		expect(fs.existsSync(filePath as string)).toBe(true);

		const yaml = fs.readFileSync(filePath as string, "utf8");
		expect(yaml).toContain('network_mode: "host"');
		expect(yaml).toContain('extra_hosts:\n      - "host.docker.internal:host-gateway"');
		expect(yaml).toContain(`- "${repoRootDir()}:${SOURCE_SRC_MOUNT}:ro"`);
		expect(yaml).toContain(`- "/tmp/deps/linux-x64/node_modules:${SOURCE_SRC_MOUNT}/node_modules:ro"`);
		expect(yaml).toContain(`- "/tmp/deps/linux-x64/bin:${SOURCE_BIN_MOUNT}:ro"`);
	});
});
