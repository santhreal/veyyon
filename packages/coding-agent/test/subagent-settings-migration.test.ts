/**
 * Migration of every pre-Subagents-tab setting onto `subagent.*`.
 *
 * WHY THIS SUITE EXISTS: the settings that decided how subagents ran were spread
 * across four places — `task.*` for the operational knobs, `task.disabledAgents`
 * plus `task.agentModelOverrides` as two agent-keyed maps that could disagree,
 * and `modelRoles.task` in the model-role table. Two owners for "is this agent
 * on" and two for "what model does it run" is what let an operator turn an agent
 * off while a model override for it lived on invisibly, and what let a role
 * outrank the subagent model.
 *
 * They are now one section with one row per agent. That is only worth anything if
 * an existing config arrives intact, so every legacy shape is pinned here: the
 * value remaps, the key renames, the two maps folding into one row set, and the
 * rule that an explicit new-key value already on disk always wins.
 *
 * Each case loads through the real loader and reads the new setting back, because
 * reaching the migration is part of the contract and so is writing a key shape the
 * loader can read: the first version of this migration stored its results under
 * dotted top-level keys, which the loader stores but `get` never sees, so every
 * legacy config silently reverted to defaults. Only a test that went through the
 * loader could catch that.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeSubagentMigrationDir = useTrackedTempDirs("veyyon-subagent-migration-");

describe("subagent settings migration", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = makeSubagentMigrationDir();
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "subagent-settings-migration"));
			agentDir = "";
		}
	});

	function writeConfig(config: Record<string, unknown>): void {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
	}

	async function load(): Promise<Settings> {
		return Settings.loadIsolated({ agentDir, cwd: agentDir });
	}

	/**
	 * `task.eager` was a three-value enum (`default` / `preferred` / `always`) and
	 * before that a boolean. `subagent.delegation` adds `off` below all of them, so
	 * the mapping has to place the old bottom value at `allowed`, not at `off`:
	 * landing on `off` would silently take the task tool away from anyone who had
	 * eager delegation switched off but still delegated by hand.
	 */
	test("maps every legacy task.eager value onto the matching delegation strength", async () => {
		for (const [legacy, expected] of [
			["always", "required"],
			["preferred", "preferred"],
			["default", "allowed"],
			[true, "required"],
			[false, "allowed"],
		] as const) {
			writeConfig({ task: { eager: legacy } });
			expect((await load()).get("subagent.delegation"), `task.eager: ${String(legacy)}`).toBe(expected);
		}
	});

	/** The operational knobs that did not change meaning keep their values under the new prefix. */
	test("carries every unchanged task.* operational knob across", async () => {
		writeConfig({
			task: {
				batch: false,
				maxConcurrency: 12,
				enableLsp: true,
				maxRuntimeMs: 60_000,
				softRequestBudget: 42,
				softRequestBudgetNotice: false,
				showResolvedModelBadge: false,
			},
		});

		const settings = await load();

		expect(settings.get("subagent.batch")).toBe(false);
		expect(settings.get("subagent.maxConcurrency")).toBe(12);
		expect(settings.get("subagent.enableLsp")).toBe(true);
		expect(settings.get("subagent.maxRuntimeMs")).toBe(60_000);
		expect(settings.get("subagent.softRequestBudget")).toBe(42);
		expect(settings.get("subagent.softRequestBudgetNotice")).toBe(false);
		expect(settings.get("subagent.showResolvedModelBadge")).toBe(false);
	});

	/**
	 * The retired recursion depth counted the root as level one. The replacement
	 * counts nested spawn levels, so every finite positive value moves down by one;
	 * `-1` remains unlimited. Both historical paths must make the same transition.
	 */
	test("translates both legacy recursion-depth paths to nested spawn depth", async () => {
		for (const legacyPath of ["task", "subagent"] as const) {
			for (const [legacy, expected] of [
				[3, 2],
				[1, 0],
				[-1, -1],
			] as const) {
				writeConfig({ [legacyPath]: { maxRecursionDepth: legacy } });
				const settings = await load();
				expect(settings.get("subagent.maxNestedSpawnDepth"), `${legacyPath}.maxRecursionDepth: ${legacy}`).toBe(
					expected,
				);
			}
		}
	});

	/**
	 * Legacy zero meant even the root could not spawn. New zero deliberately lets
	 * the root spawn direct children, so preserving the old behavior also requires
	 * turning off the subagent master switch.
	 */
	test("preserves legacy recursion depth zero through the master switch", async () => {
		for (const legacyPath of ["task", "subagent"] as const) {
			writeConfig({ [legacyPath]: { maxRecursionDepth: 0 } });
			const settings = await load();
			expect(settings.get("subagent.maxNestedSpawnDepth"), legacyPath).toBe(0);
			expect(settings.get("subagent.enabled"), legacyPath).toBe(false);
		}
	});

	/**
	 * A cap already written under the replacement key is the operator's current
	 * choice. Consuming stale legacy paths must never overwrite that explicit value.
	 */
	test("keeps an explicit nested spawn depth over both legacy paths", async () => {
		writeConfig({
			task: { maxRecursionDepth: 1 },
			subagent: { maxRecursionDepth: 3, maxNestedSpawnDepth: 7 },
		});

		expect((await load()).get("subagent.maxNestedSpawnDepth")).toBe(7);
	});

	/**
	 * The one knob that also changed NAME: `agentIdleTtlMs` said whose ttl it was
	 * back when it lived under `task.`, and repeating "agent" under `subagent.`
	 * only stutters. A rename is where a migration is most easily forgotten, so the
	 * value is pinned rather than the key's existence.
	 */
	test("renames task.agentIdleTtlMs to subagent.idleTtlMs", async () => {
		writeConfig({ task: { agentIdleTtlMs: 900_000 } });

		expect((await load()).get("subagent.idleTtlMs")).toBe(900_000);
	});

	/** Isolation moved wholesale, and its own legacy value remap still applies afterwards. */
	test("moves task.isolation.* under subagent.isolation.*", async () => {
		writeConfig({ task: { isolation: { mode: "worktree", merge: "patch", commits: "ai" } } });

		const settings = await load();

		// `worktree` is the retired spelling of `rcopy`; the two migrations compose.
		expect(settings.get("subagent.isolation.mode")).toBe("rcopy");
		expect(settings.get("subagent.isolation.merge")).toBe("patch");
		expect(settings.get("subagent.isolation.commits")).toBe("ai");
	});

	/**
	 * The headline consolidation: a disabled-name LIST and a name→model MAP become
	 * one row per agent. Two maps meant two lookups that could disagree, and the
	 * dashboard and the spawn path read different ones.
	 */
	test("folds disabledAgents and agentModelOverrides into one row per agent", async () => {
		writeConfig({
			task: {
				disabledAgents: ["designer"],
				agentModelOverrides: { scout: "openai/gpt-5" },
			},
		});

		expect((await load()).get("subagent.agents")).toEqual({
			designer: { enabled: false },
			scout: { model: "openai/gpt-5" },
		});
	});

	/**
	 * An agent that appears in BOTH legacy maps keeps both facts in its single row.
	 * Dropping the model because the agent was off would lose a choice the operator
	 * made, and they would only find out by turning the agent back on and watching
	 * it run something else.
	 */
	test("keeps the model of an agent that was also disabled", async () => {
		writeConfig({
			task: {
				disabledAgents: ["reviewer"],
				agentModelOverrides: { reviewer: "anthropic/claude-opus-4-5" },
			},
		});

		expect((await load()).get("subagent.agents")).toEqual({
			reviewer: { enabled: false, model: "anthropic/claude-opus-4-5" },
		});
	});

	/** Blank and non-string entries in the legacy maps are noise, not rows. */
	test("ignores empty and non-string entries in the legacy maps", async () => {
		writeConfig({
			task: {
				disabledAgents: ["", "   ", 7, "scout"],
				agentModelOverrides: { librarian: "", designer: 3 },
			},
		});

		expect((await load()).get("subagent.agents")).toEqual({ scout: { enabled: false } });
	});

	/**
	 * `modelRoles.task` was the "model for subagents" knob, sitting in the role
	 * table beside `smol` and `slow`. It is folded into `subagent.model` AND the
	 * role entry is deleted: leaving it would restore the two-owners situation that
	 * made a subagent model setting fail to take effect, since role expansion
	 * answered first.
	 */
	test("folds modelRoles.task into subagent.model and retires the role", async () => {
		writeConfig({ modelRoles: { default: "anthropic/claude-opus-4-5", task: "openai/gpt-5:high" } });

		const settings = await load();

		expect(settings.get("subagent.model")).toBe("openai/gpt-5:high");
		expect(settings.getModelRole("task")).toBeUndefined();
		// The unrelated roles in the same table are untouched.
		expect(settings.getModelRole("default")).toBe("anthropic/claude-opus-4-5");
	});

	/**
	 * A value already written under the new key is the operator's current choice and
	 * must win over anything the migration would copy. Without this an old
	 * `modelRoles.task` or `task.eager` left in the file would overwrite the new
	 * setting on every single load, and the new one would never appear to stick.
	 */
	test("never overwrites a value already stored under the new key", async () => {
		writeConfig({
			subagent: { delegation: "allowed", model: "anthropic/claude-sonnet-4-5" },
			task: { eager: "always" },
			modelRoles: { task: "openai/gpt-5" },
		});

		const settings = await load();

		// `task.eager: always` would fold to `required`, but an explicit new-key value wins.
		expect(settings.get("subagent.delegation")).toBe("allowed");
		expect(settings.get("subagent.model")).toBe("anthropic/claude-sonnet-4-5");
	});

	/**
	 * `subagent.delegation: off` was the kill switch before `subagent.enabled` existed,
	 * so one setting answered two questions. Someone who wrote `off` was turning
	 * subagents OFF — that is the half worth preserving — so it must land on
	 * `enabled: false` rather than on the lowest strength, which still delegates.
	 * Getting this backwards would silently switch subagents back on for every
	 * operator who had deliberately disabled them.
	 */
	test("folds the retired delegation:off onto the subagents master switch", async () => {
		writeConfig({ subagent: { delegation: "off" } });

		const settings = await load();

		expect(settings.get("subagent.enabled")).toBe(false);
		// `off` is no longer a legal strength, so it must not survive: left in place it
		// would fail validation and read as a corrupt config.
		expect(settings.get("subagent.delegation")).toBe("preferred");
	});

	/**
	 * And the fold never overrides an operator who has already answered the new
	 * question. A config carrying both the legacy `off` and an explicit
	 * `enabled: true` means they turned subagents back on under the new setting.
	 */
	test("leaves an explicit subagent.enabled alone when the legacy off is also present", async () => {
		writeConfig({ subagent: { delegation: "off", enabled: true } });

		const settings = await load();

		expect(settings.get("subagent.enabled")).toBe(true);
		expect(settings.get("subagent.delegation")).toBe("preferred");
	});

	/**
	 * The migration runs on every read of a settings source, so it has to be a FIXED
	 * POINT: applying it to its own output changes nothing. A fold that re-ran on the
	 * value it just wrote is how a migration flips a setting back and forth.
	 */
	test("is a fixed point across repeated loads", async () => {
		writeConfig({ subagent: { delegation: "off" } });

		const first = await load();
		const second = await load();

		expect(first.get("subagent.enabled")).toBe(false);
		expect(second.get("subagent.enabled")).toBe(false);
		expect(second.get("subagent.delegation")).toBe("preferred");
	});

	/** The same precedence when the new value is stored nested rather than dotted. */
	test("respects a nested subagent block already on disk", async () => {
		writeConfig({ subagent: { delegation: "preferred" }, task: { eager: "always" } });

		expect((await load()).get("subagent.delegation")).toBe("preferred");
	});

	/**
	 * A config that never touched any of this must come out on the shipped
	 * defaults, not on something the migration invented while looking for legacy
	 * keys.
	 */
	test("leaves a config with no legacy keys on the defaults", async () => {
		writeConfig({ theme: { dark: "some-theme" } });

		const settings = await load();

		expect(settings.get("subagent.enabled")).toBe(true);
		expect(settings.get("subagent.delegation")).toBe("preferred");
		expect(settings.get("subagent.model")).toBeUndefined();
		expect(settings.get("subagent.agents")).toEqual({});
	});

	/**
	 * The migrated file must not keep the legacy keys around: a leftover `task`
	 * block is a second copy of the truth, and the next reader cannot tell which
	 * one is current.
	 */
	test("removes the legacy keys from the file it writes back", async () => {
		writeConfig({
			task: { eager: "always", maxConcurrency: 4, maxRecursionDepth: 1 },
			subagent: { maxRecursionDepth: 3 },
			modelRoles: { task: "openai/gpt-5" },
		});

		const settings = await load();
		await settings.set("ask.notify" as never, "on" as never);
		await settings.flush?.();

		const onDisk = YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")) as Record<string, unknown>;
		expect(onDisk.task).toBeUndefined();
		expect((onDisk.task as Record<string, unknown> | undefined)?.maxRecursionDepth).toBeUndefined();
		expect((onDisk.subagent as Record<string, unknown> | undefined)?.maxRecursionDepth).toBeUndefined();
		expect((onDisk.modelRoles as Record<string, unknown> | undefined)?.task).toBeUndefined();
	});
});
