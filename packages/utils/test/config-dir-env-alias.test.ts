import { afterEach, describe, expect, it } from "bun:test";
import { getConfigDirName, refreshDirsFromEnv } from "@veyyon/utils/dirs";

// Clean break: only VEYYON_CONFIG_DIR is honored. The pre-rebrand OMP_/PI_
// aliases are dropped — setting them must have no effect on the config dir name.
const KEYS = ["VEYYON_CONFIG_DIR", "OMP_CONFIG_DIR", "PI_CONFIG_DIR"] as const;

describe("getConfigDirName config-dir env", () => {
	const saved: Record<string, string | undefined> = {};

	afterEach(() => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
			delete saved[key];
		}
		refreshDirsFromEnv();
	});

	function clearKeys(): void {
		for (const key of KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	}

	function defaultName(): string {
		clearKeys();
		refreshDirsFromEnv();
		return getConfigDirName();
	}

	it("honors VEYYON_CONFIG_DIR", () => {
		clearKeys();
		process.env.VEYYON_CONFIG_DIR = ".veyyon-branded";
		refreshDirsFromEnv();
		expect(getConfigDirName()).toBe(".veyyon-branded");
	});

	it("ignores the dropped PI_CONFIG_DIR alias and falls back to the default", () => {
		const fallback = defaultName();
		process.env.PI_CONFIG_DIR = ".pi-legacy";
		refreshDirsFromEnv();
		expect(getConfigDirName()).toBe(fallback);
		expect(getConfigDirName()).not.toBe(".pi-legacy");
	});

	it("ignores the dropped OMP_CONFIG_DIR alias and falls back to the default", () => {
		const fallback = defaultName();
		process.env.OMP_CONFIG_DIR = ".omp-legacy";
		refreshDirsFromEnv();
		expect(getConfigDirName()).toBe(fallback);
		expect(getConfigDirName()).not.toBe(".omp-legacy");
	});

	it("VEYYON_CONFIG_DIR wins even when the dropped aliases are also set", () => {
		clearKeys();
		process.env.VEYYON_CONFIG_DIR = ".veyyon-branded";
		process.env.OMP_CONFIG_DIR = ".omp-legacy";
		process.env.PI_CONFIG_DIR = ".pi-legacy";
		refreshDirsFromEnv();
		expect(getConfigDirName()).toBe(".veyyon-branded");
	});
});
