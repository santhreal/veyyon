/**
 * A dotted key at the TOP LEVEL of a config file names the same setting as its
 * nested spelling.
 *
 * WHY THIS SUITE EXISTS: it did not. `subagent.model: openai/gpt-5` written at the
 * top level of `config.yml` was parsed, merged into the settings tree, and then
 * never read — `get` walks nested segments, so the value sat under a literal
 * `"subagent.model"` key that nothing looked at. The operator's setting silently
 * did nothing: no warning, no invalid-value entry, no quarantine, and a `config
 * list` that showed the default. It affected EVERY setting, not one, and it was
 * found only because a migration wrote that same shape and made every legacy
 * config revert to defaults with no signal (Law 10).
 *
 * Every case loads through the real loader and reads the setting back, because the
 * bug lived precisely in the gap between "the file was accepted" and "the value is
 * readable". Asserting on the parsed tree would have passed throughout.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";

describe("flat dotted setting keys", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-flat-dotted-keys-"));
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "flat-dotted-setting-keys"));
			agentDir = "";
		}
	});

	/** Write raw YAML so the flat spelling reaches disk exactly as a person would type it. */
	function writeConfig(config: Record<string, unknown>): void {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
	}

	function readConfig(): Record<string, unknown> {
		return YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")) as Record<string, unknown>;
	}

	async function load(): Promise<Settings> {
		return Settings.loadIsolated({ agentDir, cwd: agentDir });
	}

	/**
	 * Force the file to be rewritten. The loader only writes back when something is
	 * set, so an unrelated write is how a test sees what the migration decided to
	 * keep — the same shape the migration suite uses.
	 */
	async function rewriteFile(settings: Settings): Promise<void> {
		await settings.set("ask.notify" as never, "on" as never);
		await settings.flush?.();
	}

	/**
	 * The exact shape from the report: a string setting two levels deep, written
	 * flat. Before the fix this read back as `undefined` — the schema default.
	 */
	test("a flat string setting is readable", async () => {
		writeConfig({ "subagent.model": "openai/gpt-5:high" });
		const settings = await load();
		expect(settings.get("subagent.model")).toBe("openai/gpt-5:high");
	});

	/** Booleans are the easiest to miss: the default reads as a plausible answer. */
	test("a flat boolean setting is readable, including when it is false", async () => {
		writeConfig({ "compaction.enabled": false });
		const settings = await load();
		expect(settings.get("compaction.enabled")).toBe(false);
	});

	/** Numbers and enums go through the same path; pin one of each. */
	test("flat number and enum settings are readable", async () => {
		writeConfig({ "subagent.maxConcurrency": 4, "subagent.delegation": "required" });
		const settings = await load();
		expect(settings.get("subagent.maxConcurrency")).toBe(4);
		expect(settings.get("subagent.delegation")).toBe("required");
	});

	/** Three-segment paths must expand all the way down, not just one level. */
	test("a three-segment flat key is readable", async () => {
		writeConfig({ "subagent.isolation.mode": "rcopy" });
		const settings = await load();
		expect(settings.get("subagent.isolation.mode")).toBe("rcopy");
	});

	/**
	 * Expansion must merge into an existing block rather than replace it, or setting
	 * one key flat would erase every sibling the operator nested.
	 */
	test("expanding into an existing block keeps its other keys", async () => {
		writeConfig({ subagent: { delegation: "preferred" }, "subagent.model": "openai/gpt-5" });
		const settings = await load();
		expect(settings.get("subagent.delegation")).toBe("preferred");
		expect(settings.get("subagent.model")).toBe("openai/gpt-5");
	});

	/**
	 * Both spellings of ONE setting is the operator having written two values. The
	 * nested one wins because it is the documented spelling and the one every UI
	 * writes, and the flat key is dropped so the file stops carrying a value that
	 * does nothing.
	 */
	test("the nested value wins when a setting is written both ways, and the flat key is dropped", async () => {
		writeConfig({ subagent: { model: "anthropic/claude-opus-4-5" }, "subagent.model": "openai/gpt-5" });
		const settings = await load();
		expect(settings.get("subagent.model")).toBe("anthropic/claude-opus-4-5");

		await rewriteFile(settings);
		const written = readConfig();
		expect(written["subagent.model"]).toBeUndefined();
		expect((written.subagent as Record<string, unknown>).model).toBe("anthropic/claude-opus-4-5");
	});

	/**
	 * A key this build does not know is preserved verbatim: it belongs to a newer
	 * build or another tool, and guessing at its shape would corrupt it. Expanding
	 * unknown keys would also invent blocks the schema never declared.
	 */
	test("an unknown dotted key is left exactly as written", async () => {
		writeConfig({ "someFutureFeature.enabled": true, "subagent.model": "openai/gpt-5" });
		const settings = await load();
		await rewriteFile(settings);
		const written = readConfig();
		expect(written["someFutureFeature.enabled"]).toBe(true);
		expect(written.someFutureFeature).toBeUndefined();
		expect(settings.get("subagent.model")).toBe("openai/gpt-5");
	});

	/**
	 * A scalar sitting where the block belongs blocks the expansion. Overwriting it
	 * would destroy whatever the operator put there, so the flat key is kept and the
	 * conflict reported instead.
	 */
	test("a scalar in the way is not overwritten", async () => {
		writeConfig({ subagent: "yes", "subagent.model": "openai/gpt-5" });
		const settings = await load();
		await rewriteFile(settings);
		const written = readConfig();
		expect(written.subagent).toBe("yes");
		expect(written["subagent.model"]).toBe("openai/gpt-5");
	});

	/**
	 * The expansion runs on every read of every source, so it must be a fixed point:
	 * a second load of what the first load wrote must resolve identically and must
	 * not reintroduce a dotted key.
	 */
	test("is a fixed point across a save and reload", async () => {
		writeConfig({ "subagent.model": "openai/gpt-5", "subagent.isolation.mode": "rcopy" });
		const first = await load();
		await rewriteFile(first);
		const afterFirst = readConfig();

		const second = await load();
		expect(second.get("subagent.model")).toBe("openai/gpt-5");
		expect(second.get("subagent.isolation.mode")).toBe("rcopy");
		await rewriteFile(second);
		expect(readConfig()).toEqual(afterFirst);
		expect(Object.keys(readConfig()).some(key => key.startsWith("subagent."))).toBe(false);
	});

	/**
	 * A project-level file and a `--config` overlay are never rewritten, so they can
	 * only be fixed at read time. They go through the same funnel, and this pins
	 * that the funnel is shared rather than reimplemented per source.
	 */
	test("a project config's flat key is readable too", async () => {
		const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-flat-dotted-project-"));
		try {
			fs.mkdirSync(path.join(projectDir, ".veyyon"), { recursive: true });
			fs.writeFileSync(
				path.join(projectDir, ".veyyon", "config.yml"),
				YAML.stringify({ "subagent.maxConcurrency": 2 }),
			);
			const settings = await Settings.loadIsolated({ agentDir, cwd: projectDir });
			expect(settings.get("subagent.maxConcurrency")).toBe(2);
		} finally {
			await removeWithRetries(guardDestructivePath(projectDir, "flat-dotted-setting-keys-project"));
		}
	});
});
