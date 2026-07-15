import { afterEach, describe, expect, it } from "bun:test";
import { getConfigDirName, refreshDirsFromEnv } from "@veyyon/pi-utils/dirs";

const KEYS = ["VEYYON_CONFIG_DIR", "OMP_CONFIG_DIR", "PI_CONFIG_DIR"] as const;

describe("getConfigDirName branded env aliases", () => {
	const saved: Record<string, string | undefined> = {};

	afterEach(() => {
		for (const key of KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
			delete saved[key];
		}
		refreshDirsFromEnv();
	});

	function clearAliases(): void {
		for (const key of KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	}

	it("prefers VEYYON_CONFIG_DIR over PI_CONFIG_DIR when both are set", () => {
		clearAliases();
		process.env.VEYYON_CONFIG_DIR = ".veyyon-branded";
		process.env.PI_CONFIG_DIR = ".pi-legacy";
		refreshDirsFromEnv();
		expect(getConfigDirName()).toBe(".veyyon-branded");
	});

	it("falls back to PI_CONFIG_DIR when Veyyon/OMP aliases are unset", () => {
		clearAliases();
		process.env.PI_CONFIG_DIR = ".pi-only";
		refreshDirsFromEnv();
		expect(getConfigDirName()).toBe(".pi-only");
	});

	it("accepts OMP_CONFIG_DIR between Veyyon and PI", () => {
		clearAliases();
		process.env.OMP_CONFIG_DIR = ".omp-mid";
		process.env.PI_CONFIG_DIR = ".pi-legacy";
		refreshDirsFromEnv();
		expect(getConfigDirName()).toBe(".omp-mid");
	});
});
