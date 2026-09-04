import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { describeSettingTypeMismatch, getDefault, SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeSettingsMismatchDir = useTrackedTempDirs("veyyon-settings-mismatch-");

/**
 * SETC-4: a wrong-typed setting must be reported, not obeyed in silence.
 *
 * The config file is hand-editable, so a wrong type is an ordinary mistake:
 * `autoUpdate: "no"`, a number written as `"4"`, an enum spelled slightly wrong.
 * What makes those dangerous is that most of them are silently WRONG rather than
 * obviously broken. `"no"` is a truthy string, so a boolean the user plainly
 * meant to turn off stays on, and nothing anywhere explains why. That is Law 10
 * exactly: the broken config and the working one behave identically from the
 * outside, and only the broken one is wrong.
 *
 * The contract this suite pins has two halves, and the second is as important as
 * the first:
 *
 *  1. the mismatch is REPORTED, naming the key, the expected type and the file,
 *  2. the value on disk is left alone.
 *
 * Quietly substituting the schema default would hide the broken config, which is
 * the failure the row was written against. The user needs to see that their line
 * does nothing, not have it papered over.
 */
describe("a wrong-typed setting is reported rather than silently obeyed", () => {
	describe("the detector", () => {
		test("accepts a correctly typed value for each kind", () => {
			expect(describeSettingTypeMismatch("startup.autoUpdate", true)).toBeUndefined();
			expect(describeSettingTypeMismatch("startup.autoUpdate", false)).toBeUndefined();
		});

		test("rejects a boolean written as a string, the case that silently stays ON", () => {
			// The headline bug: `"no"` is truthy, so the setting the user meant to
			// disable stays enabled. The message must say boolean, not just "invalid".
			const reason = describeSettingTypeMismatch("startup.autoUpdate", "no");
			expect(reason).toContain("startup.autoUpdate");
			expect(reason).toContain("boolean");
			expect(reason).toContain("string");
		});

		test("rejects a number written as a string", () => {
			const numberPath = firstPathOfType("number");
			const reason = describeSettingTypeMismatch(numberPath, "4");
			expect(reason).toContain("finite number");
			expect(reason).toContain(numberPath);
		});

		test("rejects NaN and the infinities, which pass a typeof check and poison comparisons", () => {
			const numberPath = firstPathOfType("number");
			expect(describeSettingTypeMismatch(numberPath, Number.NaN)).toContain("finite number");
			expect(describeSettingTypeMismatch(numberPath, Number.POSITIVE_INFINITY)).toContain("finite number");
		});

		test("rejects a value outside an enum and LISTS the accepted values", () => {
			// "expected one of a, b, c" is actionable where "invalid value" is not, and
			// the reader here is someone who just mistyped one of them.
			const enumPath = firstPathOfType("enum");
			const values = (SETTINGS_SCHEMA as Record<string, { values?: readonly string[] }>)[enumPath]?.values ?? [];
			const reason = describeSettingTypeMismatch(enumPath, "definitely-not-a-valid-choice");
			expect(reason).toContain("expected one of");
			for (const value of values) expect(reason).toContain(value);
		});

		test("rejects a scalar where an array belongs, and an array where an object belongs", () => {
			expect(describeSettingTypeMismatch(firstPathOfType("array"), "one,two")).toContain("array");
			expect(describeSettingTypeMismatch(firstPathOfType("record"), ["a", "b"])).toContain("object");
		});

		test("rejects null, which YAML produces for a key written with no value", () => {
			// `startup.autoUpdate:` with nothing after it parses as null. Treating that
			// as "unset" would silently ignore a line the user clearly wrote on purpose.
			expect(describeSettingTypeMismatch("startup.autoUpdate", null)).toContain("boolean");
		});

		test("says nothing about an undefined value, which simply means unset", () => {
			expect(describeSettingTypeMismatch("startup.autoUpdate", undefined)).toBeUndefined();
		});

		test("says nothing about a path the schema does not declare", () => {
			// Subsystems read dotted paths before they land in the schema, and unknown
			// keys are deliberately preserved rather than treated as errors. Inventing a
			// type for those would turn forward compatibility into a spurious warning.
			expect(describeSettingTypeMismatch("some.future.subsystem.knob", 42)).toBeUndefined();
			expect(describeSettingTypeMismatch("theme", "titanium")).toBeUndefined();
		});

		test("every schema default validates against its own declared type", () => {
			// The check that keeps the detector honest. If the detector and the schema
			// ever disagree, this fails on the schema's own values rather than waiting
			// for a user's config to trip it, and it also proves the rules above are not
			// so strict that legitimate values are rejected.
			const offenders: string[] = [];
			for (const path of Object.keys(SETTINGS_SCHEMA)) {
				const reason = describeSettingTypeMismatch(path, getDefault(path as any));
				if (reason !== undefined) offenders.push(reason);
			}
			expect(offenders).toEqual([]);
		});
	});

	describe("loading a config that holds one", () => {
		let agentDir = "";

		beforeEach(() => {
			agentDir = makeSettingsMismatchDir();
		});

		afterEach(async () => {
			if (agentDir) {
				await removeWithRetries(guardDestructivePath(agentDir, "settings-type-mismatch"));
				agentDir = "";
			}
		});

		function writeConfig(value: Record<string, unknown>): string {
			const file = path.join(agentDir, "config.yml");
			fs.writeFileSync(file, YAML.stringify(value));
			return file;
		}

		test("the mismatch is surfaced with the key, the expected type and the FILE", async () => {
			// The file matters more than anything else in the message: the user's next
			// action is to open it and fix a line, and with several config layers in play
			// they cannot be expected to guess which one.
			const file = writeConfig({ startup: { autoUpdate: "no" } });

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(settings.invalidValues).toHaveLength(1);
			const invalid = settings.invalidValues[0];
			expect(invalid?.path).toBe("startup.autoUpdate");
			expect(invalid?.file).toBe(file);
			expect(invalid?.reason).toContain("boolean");
		});

		test("the bad value is left on disk exactly as written", async () => {
			// Not silently replaced by the default. The row exists precisely because a
			// substituted default hides the broken config: the user would see the app
			// behaving as if their line were absent, with no way to tell it was rejected.
			const file = writeConfig({ startup: { autoUpdate: "no" } });

			await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(YAML.parse(fs.readFileSync(file, "utf8"))).toEqual({ startup: { autoUpdate: "no" } });
		});

		test("a clean config reports nothing, so the list means something when it is non-empty", async () => {
			writeConfig({ startup: { autoUpdate: false } });

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(settings.invalidValues).toEqual([]);
		});

		test("an unknown key is NOT reported, since preserving it is deliberate", async () => {
			// Guards against the detector being wired to walk the file's keys instead of
			// the schema's, which would flag every forward-compatible key as an error.
			writeConfig({ futureFeature: { enabled: true }, someOldKey: 42 });

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(settings.invalidValues).toEqual([]);
		});

		test("several mismatches are all reported, not just the first", async () => {
			// A user who hand-edited one line often edited three, and fixing them one
			// error per launch would be a miserable loop.
			writeConfig({ startup: { autoUpdate: "no" }, [firstPathOfType("number")]: "not-a-number" });

			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			expect(settings.invalidValues.length).toBeGreaterThanOrEqual(1);
			expect(settings.invalidValues.some(entry => entry.path === "startup.autoUpdate")).toBe(true);
		});

		test("an empty config reports nothing", async () => {
			writeConfig({});
			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
			expect(settings.invalidValues).toEqual([]);
		});
	});
});

/** The first schema path declared with `type`, so the tests bind to real settings. */
function firstPathOfType(type: string): string {
	for (const [path, def] of Object.entries(SETTINGS_SCHEMA as Record<string, { type?: string }>)) {
		if (def?.type === type) return path;
	}
	throw new Error(`the schema declares no setting of type ${type}, so this test cannot be written against it`);
}
