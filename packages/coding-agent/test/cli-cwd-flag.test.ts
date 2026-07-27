import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
import { applyStartupCwd } from "@veyyon/coding-agent/cli/startup-cwd";
import { getProjectDir, normalizePathForComparison, setProjectDir } from "@veyyon/utils";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeCwdLaunchDir = useTrackedTempDirs("veyyon-cwd-launch-");
const makeCwdTargetDir = useTrackedTempDirs("veyyon-cwd-target-");
const makeCwdRelDir = useTrackedTempDirs("veyyon-cwd-rel-");

const originalProjectDir = getProjectDir();

afterEach(() => {
	setProjectDir(originalProjectDir);
});
describe("parseArgs — --cwd flag", () => {
	it("parses --cwd with a space-separated directory", () => {
		const result = parseArgs(["--cwd", "/work/project", "hello"]);

		expect(result.cwd).toBe("/work/project");
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --cwd=value without leaking the value into messages", () => {
		const result = parseArgs(["--cwd=/work/project", "hello"]);

		expect(result.cwd).toBe("/work/project");
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses repeated --config overlays", () => {
		const result = parseArgs(["--config", "base.yml", "--config=team.yml", "hello"]);

		expect(result.config).toEqual(["base.yml", "team.yml"]);
		expect(result.messages).toEqual(["hello"]);
	});
	it("applies --cwd before session lookup callers read the project directory", async () => {
		const launchDir = makeCwdLaunchDir();
		const targetDir = makeCwdTargetDir();
		setProjectDir(launchDir);

		const parsed = parseArgs(["--cwd", targetDir, "--continue"]);
		await applyStartupCwd(parsed);

		expect(parsed.continue).toBe(true);
		expect(getProjectDir()).toBe(targetDir);
		expect(normalizePathForComparison(process.cwd())).toBe(normalizePathForComparison(targetDir));
	});

	it("normalizes a relative --cwd target to the resolved absolute path", async () => {
		const launchDir = makeCwdRelDir();
		const childName = "repo";
		const childDir = path.join(launchDir, childName);
		fs.mkdirSync(childDir);
		setProjectDir(launchDir);

		const parsed = parseArgs(["--cwd", childName]);
		await applyStartupCwd(parsed);

		// parsed.cwd must be the resolved absolute target, not the raw relative
		// string that would re-resolve against the new cwd (e.g. repo/repo).
		expect(path.isAbsolute(parsed.cwd ?? "")).toBe(true);
		expect(parsed.cwd).toBe(getProjectDir());
		expect(getProjectDir()).toBe(childDir);
		// Re-resolving the normalized value against the (now changed) process cwd
		// is idempotent — no doubled "repo/repo" segment.
		expect(path.resolve(parsed.cwd ?? "")).toBe(getProjectDir());
		expect(parsed.cwd?.endsWith(`${childName}${path.sep}${childName}`)).toBe(false);
	});
});
