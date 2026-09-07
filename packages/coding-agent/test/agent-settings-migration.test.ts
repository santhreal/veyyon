/**
 * Migration of every pre-Agents-tab setting onto `agent.*`.
 *
 * WHY THIS SUITE EXISTS: the settings that decided how agents ran were spread
 * across four places — `task.*` for the operational knobs, `task.disabledAgents`
 * plus `task.agentModelOverrides` as two agent-keyed maps that could disagree,
 * and `modelRoles.task` in the model-role table. Two owners for "is this agent
 * on" and two for "what model does it run" is what let an operator turn an agent
 * off while a model override for it lived on invisibly, and what let a role
 * outrank the agent model.
 *
 * They are now one section with one row per agent, and "what model does it run" has
 * exactly one owner: the blanket `agent.model`. That is only worth anything if an
 * existing config arrives intact, so every legacy shape is pinned here: the value
 * remaps, the key renames, `disabledAgents` folding into the row set, the retired
 * model map being dropped with a report instead of rewritten, and the rule that an
 * explicit new-key value already on disk always wins.
 *
 * Each case loads through the real loader and reads the new setting back, because
 * reaching the migration is part of the contract and so is writing a key shape the
 * loader can read: the first version of this migration stored its results under
 * dotted top-level keys, which the loader stores but `get` never sees, so every
 * legacy config silently reverted to defaults. Only a test that went through the
 * loader could catch that.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	getDefault,
	getEnumValues,
	getType,
	isSettingPath,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "@veyyon/coding-agent/config/settings-schema";
import { logger, removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeAgentMigrationDir = useTrackedTempDirs("veyyon-agent-migration-");

describe("agent settings migration", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = makeAgentMigrationDir();
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "agent-settings-migration"));
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
	 * before that a boolean. `agent.delegation` adds `off` below all of them, so
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
			expect((await load()).get("agent.delegation"), `task.eager: ${String(legacy)}`).toBe(expected);
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

		expect(settings.get("agent.batch")).toBe(false);
		expect(settings.get("agent.maxConcurrency")).toBe(12);
		expect(settings.get("agent.enableLsp")).toBe(true);
		expect(settings.get("agent.maxRuntimeMs")).toBe(60_000);
		expect(settings.get("agent.softRequestBudget")).toBe(42);
		expect(settings.get("agent.softRequestBudgetNotice")).toBe(false);
		expect(settings.get("agent.showResolvedModelBadge")).toBe(false);
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
				expect(settings.get("agent.maxNestedSpawnDepth"), `${legacyPath}.maxRecursionDepth: ${legacy}`).toBe(
					expected,
				);
			}
		}
	});

	/**
	 * Legacy zero meant even the root could not spawn. New zero deliberately lets
	 * the root spawn direct children, so preserving the old behavior also requires
	 * turning off the agent master switch.
	 */
	test("preserves legacy recursion depth zero through the master switch", async () => {
		for (const legacyPath of ["task", "subagent"] as const) {
			writeConfig({ [legacyPath]: { maxRecursionDepth: 0 } });
			const settings = await load();
			expect(settings.get("agent.maxNestedSpawnDepth"), legacyPath).toBe(0);
			expect(settings.get("agent.enabled"), legacyPath).toBe(false);
		}
	});

	/**
	 * A cap already written under the replacement key is the operator's current
	 * choice. Consuming stale legacy paths must never overwrite that explicit value.
	 */
	test("keeps an explicit nested spawn depth over both legacy paths", async () => {
		writeConfig({
			task: { maxRecursionDepth: 1 },
			subagent: { maxRecursionDepth: 3 },
			agent: { maxNestedSpawnDepth: 7 },
		});

		expect((await load()).get("agent.maxNestedSpawnDepth")).toBe(7);
	});

	/**
	 * The one knob that also changed NAME: `agentIdleTtlMs` said whose ttl it was
	 * back when it lived under `task.`, and repeating "agent" under `agent.`
	 * only stutters. A rename is where a migration is most easily forgotten, so the
	 * value is pinned rather than the key's existence.
	 */
	test("renames task.agentIdleTtlMs to agent.idleTtlMs", async () => {
		writeConfig({ task: { agentIdleTtlMs: 900_000 } });

		expect((await load()).get("agent.idleTtlMs")).toBe(900_000);
	});

	/** Isolation moved wholesale, and its own legacy value remap still applies afterwards. */
	test("moves task.isolation.* under agent.isolation.*", async () => {
		writeConfig({ task: { isolation: { mode: "worktree", merge: "patch", commits: "ai" } } });

		const settings = await load();

		// `worktree` is the retired spelling of `rcopy`; the two migrations compose.
		expect(settings.get("agent.isolation.mode")).toBe("rcopy");
		expect(settings.get("agent.isolation.merge")).toBe("patch");
		expect(settings.get("agent.isolation.commits")).toBe("ai");
	});

	/**
	 * The headline consolidation: a disabled-name LIST and a name→model MAP were two
	 * lookups that could disagree, and the dashboard and the spawn path read
	 * different ones. The list becomes one row per agent. The model map has no
	 * successor — per-agent models were retired in favour of the one blanket
	 * `agent.model` — so it is consumed and dropped rather than rewritten into a
	 * row nothing reads.
	 */
	test("folds disabledAgents into one row per agent and drops the model map", async () => {
		writeConfig({
			task: {
				disabledAgents: ["designer"],
				agentModelOverrides: { scout: "openai/gpt-5" },
			},
		});

		expect((await load()).get("agent.agents")).toEqual({
			designer: { enabled: false },
		});
	});

	/**
	 * A dropped value is only acceptable if the operator is told. They chose that
	 * model, and the agent will run something else from now on; the report names
	 * each override and the setting that replaced the whole map.
	 */
	test("names every dropped model override and where models are set now", async () => {
		writeConfig({
			task: { agentModelOverrides: { scout: "openai/gpt-5", reviewer: "anthropic/claude-opus-4-5" } },
		});
		const warnings: string[] = [];
		const warn = spyOn(logger, "warn").mockImplementation((message: string) => {
			warnings.push(message);
		});
		try {
			await load();
		} finally {
			warn.mockRestore();
		}

		const reported = warnings.find(message => message.includes("task.agentModelOverrides"));
		expect(reported).toBeDefined();
		expect(reported).toContain("scout=openai/gpt-5");
		expect(reported).toContain("reviewer=anthropic/claude-opus-4-5");
		expect(reported).toContain("no longer read");
		// The row this used to name is gone. A migration notice that sends the reader
		// to a deleted screen is worse than none, so it names the surface that still
		// exists and the two ways to set the value there.
		expect(reported).toContain("Agents → Roster");
		expect(reported).not.toContain("Agent Model");
		expect(reported).toContain("model:");
	});

	/**
	 * An agent that appeared in BOTH legacy maps keeps the one fact that still has a
	 * home. Writing the model beside it would put a value in the new section that no
	 * resolver reads, which is the drift this section exists to remove.
	 */
	test("keeps the disabled state of an agent that also had a model", async () => {
		writeConfig({
			task: {
				disabledAgents: ["reviewer"],
				agentModelOverrides: { reviewer: "anthropic/claude-opus-4-5" },
			},
		});

		expect((await load()).get("agent.agents")).toEqual({
			reviewer: { enabled: false },
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

		expect((await load()).get("agent.agents")).toEqual({ scout: { enabled: false } });
	});

	/**
	 * `modelRoles.task` was the "model for agents" knob, sitting in the role
	 * table beside `smol` and `slow`. It is folded into `agent.model` AND the
	 * role entry is deleted: leaving it would restore the two-owners situation that
	 * made an agent model setting fail to take effect, since role expansion
	 * answered first.
	 */
	test("folds modelRoles.task into agent.model and retires the role", async () => {
		writeConfig({ modelRoles: { default: "anthropic/claude-opus-4-5", task: "openai/gpt-5:high" } });

		const settings = await load();

		expect(settings.get("agent.model")).toBe("openai/gpt-5:high");
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
			agent: { delegation: "allowed", model: "anthropic/claude-sonnet-4-5" },
			task: { eager: "always" },
			modelRoles: { task: "openai/gpt-5" },
		});

		const settings = await load();

		// `task.eager: always` would fold to `required`, but an explicit new-key value wins.
		expect(settings.get("agent.delegation")).toBe("allowed");
		expect(settings.get("agent.model")).toBe("anthropic/claude-sonnet-4-5");
	});

	/**
	 * `agent.delegation: off` was the kill switch before `agent.enabled` existed,
	 * so one setting answered two questions. Someone who wrote `off` was turning
	 * agents OFF — that is the half worth preserving — so it must land on
	 * `enabled: false` rather than on the lowest strength, which still delegates.
	 * Getting this backwards would silently switch agents back on for every
	 * operator who had deliberately disabled them.
	 */
	test("folds the retired delegation:off onto the agents master switch", async () => {
		writeConfig({ subagent: { delegation: "off" } });

		const settings = await load();

		expect(settings.get("agent.enabled")).toBe(false);
		// `off` is no longer a legal strength, so it must not survive: left in place it
		// would fail validation and read as a corrupt config.
		expect(settings.get("agent.delegation")).toBe("preferred");
	});

	/**
	 * And the fold never overrides an operator who has already answered the new
	 * question. A config carrying both the legacy `off` and an explicit
	 * `enabled: true` means they turned agents back on under the new setting.
	 */
	test("leaves an explicit agent.enabled alone when the legacy off is also present", async () => {
		writeConfig({ subagent: { delegation: "off" }, agent: { enabled: true } });

		const settings = await load();

		expect(settings.get("agent.enabled")).toBe(true);
		expect(settings.get("agent.delegation")).toBe("preferred");
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

		expect(first.get("agent.enabled")).toBe(false);
		expect(second.get("agent.enabled")).toBe(false);
		expect(second.get("agent.delegation")).toBe("preferred");
	});

	/** The same precedence when the new value is stored nested rather than dotted. */
	test("respects a nested agent block already on disk", async () => {
		writeConfig({
			agent: { delegation: "preferred" },
			task: { eager: "always" },
			subagent: { delegation: "always" },
		});

		expect((await load()).get("agent.delegation")).toBe("preferred");
	});

	/**
	 * A config that never touched any of this must come out on the shipped
	 * defaults, not on something the migration invented while looking for legacy
	 * keys.
	 */
	test("leaves a config with no legacy keys on the defaults", async () => {
		writeConfig({ theme: { dark: "some-theme" } });

		const settings = await load();

		expect(settings.get("agent.enabled")).toBe(true);
		expect(settings.get("agent.delegation")).toBe("preferred");
		expect(settings.get("agent.model")).toBeUndefined();
		expect(settings.get("agent.agents")).toEqual({});
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
		expect(onDisk.subagent).toBeUndefined();
		expect((onDisk.agent as Record<string, unknown> | undefined)?.maxRecursionDepth).toBeUndefined();
		expect((onDisk.modelRoles as Record<string, unknown> | undefined)?.task).toBeUndefined();
	});

	/**
	 * The product vocabulary migrated from `subagent` to `agent`. The whole
	 * `subagent.*` subtree on disk is folded leaf-for-leaf into `agent.*`,
	 * including deeply nested keys such as prune thresholds and isolation options.
	 */
	test("folds a legacy subagent.* subtree leaf-for-leaf onto agent.*", async () => {
		writeConfig({
			subagent: {
				batch: false,
				maxConcurrency: 8,
				enableLsp: true,
				maxRuntimeMs: 45_000,
				idleTtlMs: 120_000,
				softRequestBudget: 25,
				softRequestBudgetNotice: false,
				showResolvedModelBadge: false,
				prune: {
					enabled: false,
					afterMs: 300_000,
					waitingAfterMs: 600_000,
				},
				isolation: {
					mode: "rcopy",
					merge: "branch",
					commits: "ai",
				},
				agents: {
					reviewer: { enabled: false },
				},
				model: "anthropic/claude-sonnet-4-5",
			},
		});

		const settings = await load();

		expect(settings.get("agent.batch")).toBe(false);
		expect(settings.get("agent.maxConcurrency")).toBe(8);
		expect(settings.get("agent.enableLsp")).toBe(true);
		expect(settings.get("agent.maxRuntimeMs")).toBe(45_000);
		expect(settings.get("agent.idleTtlMs")).toBe(120_000);
		expect(settings.get("agent.softRequestBudget")).toBe(25);
		expect(settings.get("agent.softRequestBudgetNotice")).toBe(false);
		expect(settings.get("agent.showResolvedModelBadge")).toBe(false);
		expect(settings.get("agent.prune.enabled")).toBe(false);
		expect(settings.get("agent.prune.afterMs")).toBe(300_000);
		expect(settings.get("agent.prune.waitingAfterMs")).toBe(600_000);
		expect(settings.get("agent.isolation.mode")).toBe("rcopy");
		expect(settings.get("agent.isolation.merge")).toBe("branch");
		expect(settings.get("agent.isolation.commits")).toBe("ai");
		expect(settings.get("agent.agents")).toEqual({ reviewer: { enabled: false } });
		expect(settings.get("agent.model")).toBe("anthropic/claude-sonnet-4-5");
	});

	/**
	 * An explicit new key already on disk is the operator's current choice and
	 * must win over a legacy `subagent.*` key.
	 */
	test("prefers an explicit agent.<leaf> over a legacy subagent.<leaf>", async () => {
		writeConfig({
			subagent: {
				maxConcurrency: 4,
				prune: { afterMs: 100_000 },
				model: "openai/gpt-5",
			},
			agent: {
				maxConcurrency: 16,
				prune: { afterMs: 500_000 },
				model: "anthropic/claude-opus-4-5",
			},
		});

		const settings = await load();

		expect(settings.get("agent.maxConcurrency")).toBe(16);
		expect(settings.get("agent.prune.afterMs")).toBe(500_000);
		expect(settings.get("agent.model")).toBe("anthropic/claude-opus-4-5");
	});

	/**
	 * Foreign domain keys that referred to `subagent` (`tier.subagent`, `advisor.subagents`,
	 * `argot.subagents`, and the older `serviceTierSubagent`) move to their `agent`
	 * equivalents, and an explicit new key wins over the legacy key.
	 */
	test("migrates tier.subagent, advisor.subagents, and argot.subagents to their agent equivalents", async () => {
		writeConfig({
			tier: { subagent: "flex" },
			advisor: { subagents: false },
			argot: { subagents: "inherit" },
		});

		const settings = await load();

		expect(settings.get("tier.agent")).toBe("flex");
		expect(settings.get("advisor.agents")).toBe(false);
		expect(settings.get("argot.agents")).toBe("inherit");
	});

	test("migrates serviceTierSubagent to tier.agent", async () => {
		writeConfig({
			serviceTierSubagent: "priority",
		});

		const settings = await load();

		expect(settings.get("tier.agent")).toBe("priority");
	});

	test("prefers explicit tier.agent, advisor.agents, and argot.agents over legacy subagent keys", async () => {
		writeConfig({
			tier: { subagent: "flex", agent: "priority" },
			advisor: { subagents: false, agents: true },
			argot: { subagents: "fresh", agents: "inherit" },
			serviceTierSubagent: "flex",
		});

		const settings = await load();

		expect(settings.get("tier.agent")).toBe("priority");
		expect(settings.get("advisor.agents")).toBe(true);
		expect(settings.get("argot.agents")).toBe("inherit");
	});

	/**
	 * The older `autoClose` stage was renamed to `prune`. A legacy `subagent.autoClose.parkedMs`
	 * folds first onto `agent.autoClose.parkedMs` and then migrates onto `agent.prune.afterMs`.
	 */
	test("translates legacy subagent.autoClose keys through the fold onto agent.prune", async () => {
		writeConfig({
			subagent: {
				autoClose: {
					enabled: false,
					parkedMs: 45_000,
					waitingMs: 90_000,
				},
			},
		});

		const settings = await load();

		expect(settings.get("agent.prune.enabled")).toBe(false);
		expect(settings.get("agent.prune.afterMs")).toBe(45_000);
		expect(settings.get("agent.prune.waitingAfterMs")).toBe(90_000);
	});

	/**
	 * Fixed point: loading a migrated config containing legacy subagent keys twice yields identical
	 * settings, and flushing removes all legacy subagent keys from the written file.
	 */
	test("is a fixed point for all legacy subagent keys and cleans them on flush", async () => {
		writeConfig({
			subagent: {
				maxConcurrency: 8,
				autoClose: { parkedMs: 60_000 },
				prune: { waitingAfterMs: 120_000 },
			},
			tier: { subagent: "flex" },
			advisor: { subagents: false },
			argot: { subagents: "inherit" },
			serviceTierSubagent: "flex",
		});

		const first = await load();
		const second = await load();

		expect(first.get("agent.maxConcurrency")).toBe(8);
		expect(first.get("agent.prune.afterMs")).toBe(60_000);
		expect(first.get("agent.prune.waitingAfterMs")).toBe(120_000);
		expect(first.get("tier.agent")).toBe("flex");
		expect(first.get("advisor.agents")).toBe(false);
		expect(first.get("argot.agents")).toBe("inherit");

		expect(second.get("agent.maxConcurrency")).toBe(8);
		expect(second.get("agent.prune.afterMs")).toBe(60_000);
		expect(second.get("agent.prune.waitingAfterMs")).toBe(120_000);
		expect(second.get("tier.agent")).toBe("flex");
		expect(second.get("advisor.agents")).toBe(false);
		expect(second.get("argot.agents")).toBe("inherit");

		await first.set("ask.notify" as never, "on" as never);
		await first.flush?.();

		const rawOnDisk = fs.readFileSync(path.join(agentDir, "config.yml"), "utf8");
		expect(rawOnDisk).not.toContain("subagent");
		expect(rawOnDisk).not.toContain("subagents");

		const onDisk = YAML.parse(rawOnDisk) as Record<string, unknown>;
		expect(onDisk.subagent).toBeUndefined();
		expect(onDisk.serviceTierSubagent).toBeUndefined();
		expect((onDisk.tier as Record<string, unknown> | undefined)?.subagent).toBeUndefined();
		expect((onDisk.advisor as Record<string, unknown> | undefined)?.subagents).toBeUndefined();
		expect((onDisk.argot as Record<string, unknown> | undefined)?.subagents).toBeUndefined();
	});

	/**
	 * WHERE EVERY AGENT SETTING'S LEGACY VALUE COMES FROM, ENUMERATED AT RUN TIME.
	 *
	 * Each case above pins one legacy key, which prunes those incidents and nothing else. The next
	 * setting added to this section arrives with no case at all, and a legacy key it should have
	 * consumed is then discovered by an operator whose config silently reverted to a default. So the
	 * section is enumerated from `SETTINGS_SCHEMA` and every path is probed against the real loader,
	 * and the answer for every one of them is recorded by exact equality: a new `agent.*` row is
	 * unclassified and turns this RED until someone writes down whether it has a legacy twin.
	 */
	describe("every agent setting records where its legacy value comes from", () => {
		/** Settings whose legacy value arrived under the same name below `task.`, with no transform. */
		const CARRIES_FROM_TASK: readonly string[] = [
			"agent.batch",
			"agent.enableLsp",
			"agent.isolation.commits",
			"agent.isolation.merge",
			"agent.isolation.mode",
			"agent.maxConcurrency",
			"agent.maxRuntimeMs",
			"agent.showResolvedModelBadge",
			"agent.softRequestBudget",
			"agent.softRequestBudgetNotice",
		];

		/**
		 * Settings whose legacy value came from somewhere else, or arrived in a different shape. The
		 * value mapping itself belongs to the dedicated cases above; what is asserted here is that the
		 * recorded legacy key still reaches the setting at all, which is what a rename breaks.
		 */
		const LEGACY_SOURCES: Record<string, Record<string, unknown>> = {
			"agent.agents": { task: { disabledAgents: ["designer"] } },
			"agent.delegation": { task: { eager: "always" } },
			"agent.enabled": { subagent: { delegation: "off" } },
			"agent.idleTtlMs": { task: { agentIdleTtlMs: 900_000 } },
			"agent.maxNestedSpawnDepth": { task: { maxRecursionDepth: 3 } },
			"agent.model": { modelRoles: { task: "openai/gpt-5" } },
		};

		/** Settings that never existed before this section, so there is nothing to carry. */
		const NO_LEGACY_SOURCE: readonly string[] = [
			"agent.prune.enabled",
			"agent.prune.afterMs",
			"agent.prune.waitingAfterMs",
			"agent.modelByDepth",
			"agent.thinkingLevel",
			// New with the roster's shared switch: nothing older asked this question,
			// so there is no key to carry from.
			"agent.sharedModel",
		];

		const agentPaths = Object.keys(SETTINGS_SCHEMA)
			.filter(isSettingPath)
			.filter(candidate => candidate.startsWith("agent."));

		/** A valid value for `setting` that is not its default, so a carry is visible in the value itself. */
		function probeValueFor(setting: SettingPath): unknown {
			const fallback: unknown = getDefault(setting);
			switch (getType(setting)) {
				case "boolean":
					return fallback !== true;
				case "number":
					return typeof fallback === "number" ? fallback + 1 : 7;
				case "enum":
					return getEnumValues(setting)?.find(value => value !== fallback);
				case "record":
					return { scout: { enabled: false } };
				default:
					return "openai/gpt-5";
			}
		}

		function nest(segments: readonly string[], value: unknown): Record<string, unknown> {
			const [head, ...rest] = segments;
			if (head === undefined) throw new Error("nest needs at least one segment");
			return { [head]: rest.length === 0 ? value : nest(rest, value) };
		}

		const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

		test("carries exactly the settings recorded as same-name task keys", async () => {
			const carried: string[] = [];
			for (const setting of agentPaths) {
				const probe = probeValueFor(setting);
				writeConfig({ task: nest(setting.slice("agent.".length).split("."), probe) });
				if (same((await load()).get(setting), probe)) carried.push(setting);
			}

			expect(carried.sort()).toEqual([...CARRIES_FROM_TASK].sort());
		});

		test("classifies every setting in the section", () => {
			const classified = [...CARRIES_FROM_TASK, ...Object.keys(LEGACY_SOURCES), ...NO_LEGACY_SOURCE];

			expect(classified.sort()).toEqual([...agentPaths].sort());
			// Nothing may be recorded twice: two answers for one setting is the ambiguity being removed.
			expect(new Set(classified).size).toBe(classified.length);
		});

		test("still reaches the setting from every recorded legacy key", async () => {
			const inert: string[] = [];
			for (const [setting, legacy] of Object.entries(LEGACY_SOURCES)) {
				if (!isSettingPath(setting)) throw new Error(`not a setting path: ${setting}`);
				writeConfig(legacy);
				if (same((await load()).get(setting), getDefault(setting))) inert.push(setting);
			}

			expect(inert).toEqual([]);
		});
	});
});
