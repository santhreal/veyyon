/**
 * A chain of models is one setting with two spellings, and both are valid.
 *
 * `compaction.model` and `subagent.model` hold an ORDERED CHAIN: the first model
 * is tried, and the rest are used when an earlier one errors. Every reader goes
 * through `normalizeModelPatternList`, which splits a comma string and flattens a
 * list into the same array, so `"opus,sonnet"` and `["opus", "sonnet"]` have
 * always meant the same thing at runtime.
 *
 * THE SCHEMA DISAGREED WITH THE RUNTIME. Both settings were declared
 * `type: "string"`, so a config written as a YAML list was reported by
 * `describeSettingTypeMismatch` as a value that "does not match its declared
 * type" and shown to the user as invalid, while the value was read correctly.
 * The handbook shows the list form for `subagent.model`, because a list of models
 * reads as a list, so the DOCUMENTED spelling was the one being flagged. A user
 * following the docs got a warning about their own working config, which teaches
 * them to distrust the warning rather than to fix anything.
 *
 * They are declared `type: "modelChain"` now, which admits both encodings and
 * still refuses what is genuinely wrong. This suite pins both halves: the two
 * spellings load clean, and a number, an object, or a list with a non-string in
 * it is still reported.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeModelPatternList } from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { describeSettingTypeMismatch, getType } from "@veyyon/coding-agent/config/settings-schema";
import * as YAML from "yaml";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeChainConfigDir = useTrackedTempDirs("veyyon-model-chain-");

/** The two settings that hold a chain. Both must answer the same way. */
const CHAIN_PATHS = ["compaction.model", "subagent.model"] as const;

describe("the detector accepts either spelling of a chain", () => {
	/**
	 * The declaration itself, asserted so the rest of the suite cannot pass by
	 * accident against a setting that quietly went back to `string`.
	 */
	test("both chain settings are declared as chains", () => {
		for (const chainPath of CHAIN_PATHS) {
			expect(getType(chainPath)).toBe("modelChain");
		}
	});

	/**
	 * A comma string, which is what a CLI flag and the settings text box produce.
	 */
	test("a comma-separated string is valid", () => {
		for (const chainPath of CHAIN_PATHS) {
			expect(describeSettingTypeMismatch(chainPath, "opus,sonnet")).toBeUndefined();
			expect(describeSettingTypeMismatch(chainPath, "opus")).toBeUndefined();
			expect(describeSettingTypeMismatch(chainPath, "")).toBeUndefined();
		}
	});

	/**
	 * A YAML list, which is the case the old declaration reported as invalid and
	 * the one the handbook shows.
	 */
	test("a list of patterns is valid", () => {
		for (const chainPath of CHAIN_PATHS) {
			expect(describeSettingTypeMismatch(chainPath, ["opus", "sonnet"])).toBeUndefined();
			expect(describeSettingTypeMismatch(chainPath, ["opus"])).toBeUndefined();
			// An empty list is "no chain configured", which is what unsetting looks
			// like in a file that keeps the key.
			expect(describeSettingTypeMismatch(chainPath, [])).toBeUndefined();
		}
	});

	/**
	 * And the two spellings really are the same chain, not merely both accepted.
	 *
	 * Accepting a list while reading only its first entry would satisfy every
	 * assertion above and still lose the user's fallbacks, so the reader is
	 * asserted here beside the validator.
	 */
	test("both spellings normalize to the same chain", () => {
		expect(normalizeModelPatternList("opus,sonnet")).toEqual(["opus", "sonnet"]);
		expect(normalizeModelPatternList(["opus", "sonnet"])).toEqual(["opus", "sonnet"]);
		expect(normalizeModelPatternList("opus, sonnet")).toEqual(["opus", "sonnet"]);
		// A list whose entries are themselves comma strings is flattened, so a
		// half-converted config still means what it looks like.
		expect(normalizeModelPatternList(["opus,sonnet", "haiku"])).toEqual(["opus", "sonnet", "haiku"]);
	});
});

describe("the detector still refuses what is genuinely wrong", () => {
	/**
	 * The guard on the guard. A case that returned `undefined` for everything
	 * would pass every test above while removing the validation entirely.
	 */
	test("a number and an object are reported", () => {
		for (const chainPath of CHAIN_PATHS) {
			const fromNumber = describeSettingTypeMismatch(chainPath, 4);
			expect(fromNumber).toContain(chainPath);
			expect(fromNumber).toContain("a model pattern, or a list of them");

			expect(describeSettingTypeMismatch(chainPath, { model: "opus" })).toContain(chainPath);
			expect(describeSettingTypeMismatch(chainPath, true)).toContain(chainPath);
		}
	});

	/**
	 * A list is not a blank cheque: an entry that is not a pattern is reported,
	 * and the message names WHICH entry.
	 *
	 * `["opus", 4]` is the shape a hand-edited file produces when a model name
	 * happens to look like a number and YAML types it as one. Saying "expected a
	 * list of strings" would leave the user hunting through a long chain.
	 */
	test("a list with a non-string entry is reported, naming the index", () => {
		const reason = describeSettingTypeMismatch("subagent.model", ["opus", 4]);

		expect(reason).toContain("subagent.model");
		expect(reason).toContain("at index 1");
		expect(reason).toContain("number");
	});

	/**
	 * An unset chain is not a mismatch, which is the ordinary case for both
	 * settings: unset means inherit the live main model.
	 */
	test("an absent value is not a mismatch", () => {
		for (const chainPath of CHAIN_PATHS) {
			expect(describeSettingTypeMismatch(chainPath, undefined)).toBeUndefined();
		}
	});
});

describe("a config file written either way loads clean", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = makeChainConfigDir();
	});

	afterEach(() => {
		agentDir = "";
	});

	function writeConfig(value: Record<string, unknown>): void {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(value));
	}

	/**
	 * The end-to-end case the row was written against: the documented spelling,
	 * loaded from a real file, reports nothing.
	 */
	test("a YAML list reports no invalid value", async () => {
		writeConfig({ subagent: { model: ["opus", "sonnet"] }, compaction: { model: ["opus", "sonnet"] } });

		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		expect(settings.invalidValues).toEqual([]);
	});

	/**
	 * The comma string, loaded the same way, so a regression in the common case is
	 * not hidden by the list case passing.
	 */
	test("a comma string reports no invalid value", async () => {
		writeConfig({ subagent: { model: "opus,sonnet" }, compaction: { model: "opus,sonnet" } });

		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		expect(settings.invalidValues).toEqual([]);
	});

	/**
	 * And the value read back is the value on disk, in the shape it was written.
	 *
	 * The fix must not have been "coerce the list into a string on load", which
	 * would rewrite the user's file shape out from under them and would also be
	 * invisible to the assertions above.
	 */
	test("the configured value survives the load in the shape it was written", async () => {
		writeConfig({ subagent: { model: ["opus", "sonnet"] } });

		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		expect(settings.get("subagent.model")).toEqual(["opus", "sonnet"]);
	});

	/**
	 * A wrong value in a real file is still surfaced with its file, which is the
	 * half of the contract that makes the report actionable.
	 */
	test("a wrong-typed chain is still reported with its file", async () => {
		writeConfig({ subagent: { model: 4 } });

		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

		expect(settings.invalidValues).toHaveLength(1);
		expect(settings.invalidValues[0]?.path).toBe("subagent.model");
		expect(settings.invalidValues[0]?.file).toContain("config.yml");
	});
});
