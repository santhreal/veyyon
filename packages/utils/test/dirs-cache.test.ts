import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	APP_NAME,
	getActiveProfile,
	getConfigDirName,
	getDocumentConversionCacheDir,
	getProfileRootDir,
	setAgentDir,
} from "@veyyon/utils/dirs";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

describe("document conversion cache directory", () => {
	let tempRoot = "";
	let originalAgentDir: string | undefined;
	let originalProfile: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(async () => {
		originalAgentDir = process.env.VEYYON_CODING_AGENT_DIR;
		originalProfile = process.env.VEYYON_PROFILE;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		tempRoot = mkdtempSync(path.join(os.tmpdir(), "veyyon-utils-document-cache-"));
		await fs.mkdir(tempRoot, { recursive: true });
	});

	afterEach(async () => {
		restoreEnv("VEYYON_CODING_AGENT_DIR", originalAgentDir);
		restoreEnv("VEYYON_PROFILE", originalProfile);
		restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("uses XDG_CACHE_HOME for the default agent dir when $XDG_CACHE_HOME/veyyon exists", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
		await fs.mkdir(path.join(process.env.XDG_CACHE_HOME, APP_NAME), { recursive: true });

		const defaultAgentDir = path.join(os.homedir(), getConfigDirName(), "profiles", "default", "agent");
		setAgentDir(defaultAgentDir);

		expect(getDocumentConversionCacheDir()).toBe(
			path.join(process.env.XDG_CACHE_HOME, APP_NAME, "cache", "document-conversions"),
		);
	});

	it("stays under a custom VEYYON_CODING_AGENT_DIR", () => {
		const customAgentDir = path.join(tempRoot, "custom-agent");

		setAgentDir(customAgentDir);

		expect(getDocumentConversionCacheDir()).toBe(path.join(customAgentDir, "cache", "document-conversions"));
	});
});

describe("test directory state cleanup", () => {
	it("restores the active profile from the current env after setAgentDir mutations", () => {
		const originalAgentDir = process.env.VEYYON_CODING_AGENT_DIR;
		const originalProfile = process.env.VEYYON_PROFILE;
		const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		try {
			delete process.env.VEYYON_PROFILE;
			delete process.env.VEYYON_CODING_AGENT_DIR;
			delete process.env.XDG_CACHE_HOME;
			__resetDirsFromEnvForTests();

			// A fresh directory each run, so two runs on one machine cannot share it. It only
			// has to be a path OUTSIDE any profile root for the assertion below to mean
			// anything; `mkdtemp` gives that and leaves nothing behind.
			setAgentDir(path.join(mkdtempSync(path.join(os.tmpdir(), "veyyon-utils-document-cache-")), "agent"));
			expect(getActiveProfile()).toBeUndefined();

			process.env.VEYYON_PROFILE = "cache-profile";
			delete process.env.VEYYON_CODING_AGENT_DIR;
			__resetDirsFromEnvForTests();

			expect(getActiveProfile()).toBe("cache-profile");
			expect(getDocumentConversionCacheDir()).toBe(
				path.join(getProfileRootDir("cache-profile"), "agent", "cache", "document-conversions"),
			);
		} finally {
			restoreEnv("VEYYON_CODING_AGENT_DIR", originalAgentDir);
			restoreEnv("VEYYON_PROFILE", originalProfile);
			restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
			__resetDirsFromEnvForTests();
		}
	});
});
