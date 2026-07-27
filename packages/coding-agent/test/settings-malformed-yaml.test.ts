import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeSettingsMalformedDir = useTrackedTempDirs("veyyon-settings-malformed-");

/**
 * SETC-1: a settings file that cannot be understood must say so and keep its
 * bytes, never quietly load as empty.
 *
 * Loading an unparseable config as `{}` is the worst available outcome. Every
 * setting the user configured silently reverts to a default, the app behaves
 * like a fresh install, and the one thing that would explain it (a stray tab, an
 * unclosed quote) is invisible. Worse, the next successful save would then write
 * the defaults back over the file and destroy the original for good.
 *
 * The implemented contract has three parts, and this suite pins all three
 * because each fails differently:
 *
 *  1. the file is QUARANTINED, so the user's bytes still exist somewhere,
 *  2. the failure is REPORTED through `quarantinedFiles`, naming both paths,
 *  3. the session continues on defaults rather than refusing to start.
 *
 * The third is deliberate: refusing to launch over a bad config would strand
 * someone whose only way to fix it is a terminal they can no longer open the
 * tool in.
 *
 * A file that parses cleanly but to a NON-mapping (a bare scalar, a sequence) is
 * treated identically. It is the sneakier case: `YAML.parse` succeeds, so a
 * loader that only catches exceptions would return the parsed scalar or fall
 * through to `{}` with no error at all.
 */
describe("a malformed settings file is quarantined and reported, never silently empty", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = makeSettingsMalformedDir();
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "settings-malformed-yaml"));
			agentDir = "";
		}
	});

	function writeConfig(body: string): string {
		const file = path.join(agentDir, "config.yml");
		fs.writeFileSync(file, body);
		return file;
	}

	describe("YAML that does not parse", () => {
		test("is reported with both the original path and where the bytes were kept", async () => {
			// Naming the quarantine path is what makes this recoverable: the user's
			// settings are not gone, and the message has to say where they went.
			const file = writeConfig("startup:\n  autoUpdate: [unclosed\n");

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(settings.quarantinedFiles).toHaveLength(1);
			const entry = settings.quarantinedFiles[0];
			expect(entry?.path).toBe(file);
			expect(entry?.quarantinePath).toBeTruthy();
		});

		test("the original bytes survive at the quarantine path, character for character", async () => {
			// The point of quarantining rather than deleting. A user can copy the file
			// back after fixing one line, so the content must be preserved exactly.
			const body = "startup:\n  autoUpdate: [unclosed\n# a comment they wrote\n";
			writeConfig(body);

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
			const quarantinePath = settings.quarantinedFiles[0]?.quarantinePath;

			expect(quarantinePath).toBeTruthy();
			expect(fs.readFileSync(quarantinePath as string, "utf8")).toBe(body);
		});

		test("the session still starts, on defaults", async () => {
			// Refusing to launch would strand someone whose only way to fix the file is
			// a terminal they can no longer open the tool in.
			writeConfig(": : :\n\t- broken\n");

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(settings.get("startup.autoUpdate")).toBe(true);
		});
	});

	describe("YAML that parses but is not a settings mapping", () => {
		test("a bare scalar is quarantined exactly like a parse error", async () => {
			// The sneaky case: `YAML.parse("just a string")` SUCCEEDS. A loader that
			// only caught exceptions would sail past this and load nothing, with no
			// error anywhere.
			const file = writeConfig("just a string\n");

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(settings.quarantinedFiles.map(entry => entry.path)).toEqual([file]);
		});

		test("a YAML sequence at the root is quarantined too", async () => {
			const file = writeConfig("- one\n- two\n");

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(settings.quarantinedFiles.map(entry => entry.path)).toEqual([file]);
		});
	});

	describe("files that are legitimately empty", () => {
		test("a blank file is NOT quarantined, because empty is a real state", async () => {
			// Someone who deleted every setting deliberately must not be told their
			// config is broken; over-reporting here would train people to ignore it.
			writeConfig("");

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(settings.quarantinedFiles).toEqual([]);
		});

		test("a comments-only file is not quarantined either", async () => {
			writeConfig("# everything is commented out\n# for now\n");

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(settings.quarantinedFiles).toEqual([]);
		});

		test("a valid config is not quarantined and its value is read", async () => {
			// The control that keeps every assertion above meaningful: without it they
			// would all still pass if loading had simply stopped working.
			writeConfig("startup:\n  autoUpdate: false\n");

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(settings.quarantinedFiles).toEqual([]);
			expect(settings.get("startup.autoUpdate")).toBe(false);
		});
	});
});
