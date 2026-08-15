/**
 * WHY THIS SUITE EXISTS (MODEL-BY-DEPTH ENTRY VALIDATION).
 *
 * `subagent.modelByDepth` is a hand-editable map: its keys are spawn depths and
 * its values are model chains. Two mistakes in it are silent without validation.
 * A key that is not a positive integer — `0`, `-1`, `1.5`, `two`, a YAML-quoted
 * `01` — never matches a spawn's depth, so the row sits in the config looking
 * configured and deciding nothing. A value that is not a chain is junk the
 * resolver cannot honor either way.
 *
 * The report goes through the settings validation path
 * (`describeSettingTypeMismatch`, surfaced by the loader as an invalid value
 * with its file named), the same place a wrong-typed `subagent.model` is
 * reported. Silently ignoring the entry is the failure mode this suite exists
 * to prevent; refusing the whole map would punish the valid rows beside the bad
 * one, so the report names the entry and the valid rows keep working.
 *
 * WHAT THIS DOES NOT CATCH: a chain value that is well-typed but names no real
 * model. That is the resolver's refusal path (`unresolved`), covered by the
 * per-depth precedence suite, not by type validation.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { describeSettingTypeMismatch } from "@veyyon/coding-agent/config/settings-schema";
import { resolveSubagentModel } from "@veyyon/coding-agent/task/subagent-settings";
import * as YAML from "yaml";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const PATH = "subagent.modelByDepth";
const makeMapConfigDir = useTrackedTempDirs("veyyon-model-by-depth-");

describe("the entry validator accepts real depth rows", () => {
	test("positive-integer keys with either chain spelling", () => {
		expect(describeSettingTypeMismatch(PATH, { "1": "opus,sonnet", "2": ["opus", "sonnet"], "10": "opus" })).toBeUndefined();
	});

	test("an empty map and an absent value, the unset states", () => {
		expect(describeSettingTypeMismatch(PATH, {})).toBeUndefined();
		expect(describeSettingTypeMismatch(PATH, undefined)).toBeUndefined();
	});
});

describe("the entry validator reports keys that can never match a spawn depth", () => {
	/**
	 * One case per wrong shape, each named in the report, because "invalid key"
	 * without the key sends the operator hunting through the map. `0` is the
	 * tempting one: the root session IS depth zero, and a row for it reads as
	 * sensible while being unreachable — depth rows decide what a SPAWN runs,
	 * and no spawn runs at depth zero.
	 */
	test.each([
		["zero", { "0": "opus" }, "0"],
		["negative", { "-1": "opus" }, "-1"],
		["fractional", { "1.5": "opus" }, "1.5"],
		["a word", { two: "opus" }, "two"],
		["zero-padded", { "01": "opus" }, "01"],
	])("%s is reported, naming the key", (_label, value, key) => {
		const reason = describeSettingTypeMismatch(PATH, value);

		expect(reason).toContain(PATH);
		expect(reason).toContain(key);
	});
});

describe("the entry validator reports values that are not a chain", () => {
	/**
	 * The value shape is the one `subagent.model` already declares: a pattern
	 * string or a list of them. Anything else — a number, an object, a list
	 * with a non-string in it — is the same mistake a hand-edited chain is, one
	 * nesting level down.
	 */
	test("a number, an object, and a list with a non-string entry", () => {
		expect(describeSettingTypeMismatch(PATH, { "1": 4 })).toContain(PATH);
		expect(describeSettingTypeMismatch(PATH, { "1": { model: "opus" } })).toContain(PATH);

		const fromList = describeSettingTypeMismatch(PATH, { "2": ["opus", 4] });
		expect(fromList).toContain(PATH);
		expect(fromList).toContain("2");
	});

	test("a non-record value for the whole map", () => {
		expect(describeSettingTypeMismatch(PATH, "opus")).toContain("object");
		expect(describeSettingTypeMismatch(PATH, ["opus"])).toContain("object");
	});
});

describe("a hand-edited config file through the real loader", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = makeMapConfigDir();
	});

	afterEach(() => {
		agentDir = "";
	});

	/**
	 * The end-to-end contract: the bad entry is reported with its file, and the
	 * VALID row beside it still decides. Reporting the map as one undifferentiated
	 * blob — or worse, dropping it — would throw the working row out with the bad
	 * one.
	 */
	test("reports the bad key with its file while the valid row still resolves", async () => {
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ subagent: { modelByDepth: { "0": "opus", "2": "sonnet" } } }),
		);

		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		expect(settings.invalidValues).toHaveLength(1);
		expect(settings.invalidValues[0]?.path).toBe(PATH);
		expect(settings.invalidValues[0]?.file).toContain("config.yml");
		expect(settings.invalidValues[0]?.reason).toContain("0");
		expect(resolveSubagentModel({ settings, agentName: "reviewer", taskDepth: 2 }).patterns).toEqual(["sonnet"]);
	});

	test("a clean map reports nothing", async () => {
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			YAML.stringify({ subagent: { modelByDepth: { "1": "opus,sonnet", "2": ["haiku"] } } }),
		);

		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		expect(settings.invalidValues).toEqual([]);
	});
});
