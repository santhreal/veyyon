import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildArgotGate } from "@veyyon/coding-agent/argot-wire";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentStorage } from "@veyyon/coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";
import { shouldEncode } from "argot";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/**
 * `argot.models` / `argot.disableAboveTokens` -> `argot.encode.*`, on load.
 *
 * WHY THE KEYS MOVED. Argot has six settings and only two of them decide whether the model is taught
 * to WRITE shorthand. The other four decide whether the feature runs at all, when a dictionary is
 * built, how many tokens it may spend, and what a spawned agent starts with. Decoding is
 * unconditional: a handle already in the history expands whatever any of these hold. Flat, the two
 * encode gates read like four peers of the other four, and an operator could not tell from the key
 * names that turning `models` off stops teaching without stopping expansion. `argot.encode.models`
 * and `argot.encode.disableAboveTokens` say it, the way `read.summarize.*` and `bash.autoBackground.*`
 * already group their sub-features in this schema.
 *
 * WHY A MIGRATION AND NOT A BREAK. A renamed key with no migration is a setting that silently stops
 * being read: the file still parses, the old value is still there to look at, and the behaviour it
 * bought is gone. For `argot.models` that failure is invisible in the worst way, because an ignored
 * allowlist means NO model is taught shorthand, which looks exactly like Argot working with nothing
 * to say.
 *
 * WHAT THESE CASES PIN. The migration runs on every load of every source (global config, project
 * config, `--config` overlays, runtime overrides), so it has to be a fixed point on its own output.
 * Both spellings have to be folded, because the dotted-key expansion that turns `a.b: v` into nested
 * form only expands REGISTERED paths and these two are retired. And the nested value has to win over
 * the flat one, so a config carrying both does not depend on the order the migration happens to visit
 * them. Every case below is one of those properties, plus the wiring case that proves a legacy config
 * still arms the real encode gate rather than merely storing a value somewhere.
 */

const MODEL = "anthropic/claude-opus-4";
const OTHER = "google-antigravity/gemini-3.5-flash";

describe("argot encode keys migrate from their flat spelling", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@test-argot-encode-migration-");
		agentDir = path.join(tempDir.path(), "agent");
		projectDir = path.join(tempDir.path(), "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	/** Write a config exactly as a user's file has it, then load it the way startup does. */
	async function loadWith(raw: Record<string, unknown>): Promise<Settings> {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(raw, null, 2));
		resetSettingsForTest();
		return Settings.init({ cwd: projectDir, agentDir });
	}

	describe("the nested config shape a user's file has", () => {
		/**
		 * The allowlist is the setting that must not be lost: empty means no model encodes, so an
		 * ignored list turns Argot inert while every other sign says it is on. Asserted as the exact
		 * array, because a truthy check would pass on the empty default.
		 */
		it("moves argot.models to argot.encode.models", async () => {
			const settings = await loadWith({ argot: { enabled: true, models: [MODEL, OTHER] } });

			expect(settings.get("argot.encode.models")).toEqual([MODEL, OTHER]);
		});

		/** The cutoff, same shape, and asserted as the exact number rather than "not the default". */
		it("moves argot.disableAboveTokens to argot.encode.disableAboveTokens", async () => {
			const settings = await loadWith({ argot: { enabled: true, disableAboveTokens: 200_000 } });

			expect(settings.get("argot.encode.disableAboveTokens")).toBe(200_000);
		});

		/**
		 * BOTH AT ONCE, which is the case the obvious implementation gets wrong. Resolve the
		 * destination block once before the loop and the second key replaces the block the first key
		 * created, so `models` disappears and nothing reports it. This is the case that would have
		 * caught it.
		 */
		it("moves both keys in one load without either losing the other", async () => {
			const settings = await loadWith({
				argot: { enabled: true, models: [MODEL], disableAboveTokens: 400_000 },
			});

			expect(settings.get("argot.encode.models")).toEqual([MODEL]);
			expect(settings.get("argot.encode.disableAboveTokens")).toBe(400_000);
		});

		/** The four settings that are not encode gates stay where they are and keep their values. */
		it("leaves the other four argot settings untouched", async () => {
			const settings = await loadWith({
				argot: {
					enabled: true,
					models: [MODEL],
					autoload: false,
					tokenBudget: 2000,
					subagents: "inherit",
				},
			});

			expect(settings.get("argot.enabled")).toBe(true);
			expect(settings.get("argot.autoload")).toBe(false);
			expect(settings.get("argot.tokenBudget")).toBe(2000);
			expect(settings.get("argot.subagents")).toBe("inherit");
		});
	});

	describe("the flat dotted spelling, which the key expansion cannot reach", () => {
		/**
		 * `argot.models:` written as one dotted key in YAML is a shape this repo's configs really use
		 * (see `test/config/flat-dotted-setting-keys.test.ts`). The expansion that normally folds
		 * dotted keys into the nested tree only knows REGISTERED paths, and a retired key is not one,
		 * so without this branch the value would sit in the tree with nothing reading it.
		 */
		it("folds a flat argot.models key", async () => {
			const settings = await loadWith({ "argot.enabled": true, "argot.models": [MODEL] });

			expect(settings.get("argot.encode.models")).toEqual([MODEL]);
		});

		it("folds a flat argot.disableAboveTokens key", async () => {
			const settings = await loadWith({ "argot.enabled": true, "argot.disableAboveTokens": 100_000 });

			expect(settings.get("argot.encode.disableAboveTokens")).toBe(100_000);
		});

		/** Both flat keys together, for the same reason the nested pair is checked together. */
		it("folds both flat keys without either losing the other", async () => {
			const settings = await loadWith({
				"argot.enabled": true,
				"argot.models": [OTHER],
				"argot.disableAboveTokens": 600_000,
			});

			expect(settings.get("argot.encode.models")).toEqual([OTHER]);
			expect(settings.get("argot.encode.disableAboveTokens")).toBe(600_000);
		});

		/** A mixed file: one key flat, the other nested. Neither shape may shadow the other. */
		it("folds a flat key alongside a nested one", async () => {
			const settings = await loadWith({
				argot: { enabled: true, disableAboveTokens: 300_000 },
				"argot.models": [MODEL],
			});

			expect(settings.get("argot.encode.models")).toEqual([MODEL]);
			expect(settings.get("argot.encode.disableAboveTokens")).toBe(300_000);
		});
	});

	describe("the new spelling wins, so the fold never depends on visit order", () => {
		/**
		 * A file that carries both spellings is not hypothetical: a user copies the new key out of the
		 * handbook and leaves the old line in place. The new one is what they meant, so the retired
		 * key is dropped WITHOUT being read. That is also what makes the migration a fixed point, and
		 * the two properties are the same property.
		 */
		it("keeps the nested value when both spellings are present", async () => {
			const settings = await loadWith({
				argot: { enabled: true, models: [OTHER], encode: { models: [MODEL] } },
			});

			expect(settings.get("argot.encode.models")).toEqual([MODEL]);
		});

		it("keeps the nested cutoff when both spellings are present", async () => {
			const settings = await loadWith({
				argot: { enabled: true, disableAboveTokens: 100_000, encode: { disableAboveTokens: 800_000 } },
			});

			expect(settings.get("argot.encode.disableAboveTokens")).toBe(800_000);
		});

		/** And with the retired key in its flat spelling, which takes the other branch. */
		it("keeps the nested value over a flat retired key", async () => {
			const settings = await loadWith({
				argot: { enabled: true, encode: { models: [MODEL] } },
				"argot.models": [OTHER],
			});

			expect(settings.get("argot.encode.models")).toEqual([MODEL]);
		});
	});

	describe("it is a fixed point, because it runs on every load of every source", () => {
		/**
		 * Load, write the migrated tree back out, load again: the second answer must equal the first.
		 * A migration that is not a fixed point cannot live in this function at all (the schema has a
		 * separate one-shot path for those), and the failure mode is a value that drifts once per
		 * load rather than an error anyone would see.
		 */
		it("gives the same answer when its own output is loaded again", async () => {
			const first = await loadWith({ argot: { enabled: true, models: [MODEL], disableAboveTokens: 200_000 } });
			const once = {
				models: first.get("argot.encode.models"),
				cutoff: first.get("argot.encode.disableAboveTokens"),
			};

			const second = await loadWith({
				argot: { enabled: true, encode: { models: once.models, disableAboveTokens: once.cutoff } },
			});

			expect(second.get("argot.encode.models")).toEqual(once.models);
			expect(second.get("argot.encode.disableAboveTokens")).toBe(once.cutoff as number);
		});

		/**
		 * THE CASE A MUTATION RUN ASKED FOR. Deleting the retired key was the one part of this
		 * migration that nothing checked: with the `delete` removed, every case above still passed,
		 * because reading goes through the new path either way. What breaks is the FILE. A surviving
		 * `argot.models` is a second copy of the truth that no longer drives anything, so the next
		 * person to change the allowlist has even odds of editing the dead line and concluding the
		 * setting does not work. The same reasoning is why the subagent migration strips its legacy
		 * `task` block, and it is checked the same way: write back, then read what is on disk.
		 */
		it("removes the retired keys from the file it writes back", async () => {
			const settings = await loadWith({
				argot: { enabled: true, models: [MODEL], disableAboveTokens: 200_000 },
			});
			await settings.set("ask.notify" as never, "on" as never);
			await settings.flush?.();

			const onDisk = YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")) as Record<
				string,
				unknown
			>;
			const argot = onDisk.argot as Record<string, unknown>;

			expect(argot.models).toBeUndefined();
			expect(argot.disableAboveTokens).toBeUndefined();
			expect(argot.encode).toEqual({ models: [MODEL], disableAboveTokens: 200_000 });
		});

		/**
		 * And the flat spelling, which is written as a dotted top-level key and so is deleted from a
		 * different place in the tree. Left behind, it survives every load untouched: the dotted-key
		 * expansion skips retired paths, so nothing else would ever remove it.
		 */
		it("removes the retired flat keys from the file it writes back", async () => {
			const settings = await loadWith({
				"argot.enabled": true,
				"argot.models": [OTHER],
				"argot.disableAboveTokens": 600_000,
			});
			await settings.set("ask.notify" as never, "on" as never);
			await settings.flush?.();

			const onDisk = YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")) as Record<
				string,
				unknown
			>;

			expect(onDisk["argot.models"]).toBeUndefined();
			expect(onDisk["argot.disableAboveTokens"]).toBeUndefined();
			expect((onDisk.argot as Record<string, unknown>).encode).toEqual({
				models: [OTHER],
				disableAboveTokens: 600_000,
			});
		});

		/** A config that never had the old keys is unaffected: the defaults are the shipped defaults. */
		it("leaves a config that never used the old keys on the shipped defaults", async () => {
			const settings = await loadWith({ argot: { enabled: true } });

			expect(settings.get("argot.encode.models")).toEqual([]);
			expect(settings.get("argot.encode.disableAboveTokens")).toBe(-1);
		});

		/** And an empty config: the migration must not materialise an `encode` block from nothing. */
		it("does not invent an encode block for a config with no argot section", async () => {
			const settings = await loadWith({});

			expect(settings.get("argot.encode.models")).toEqual([]);
			expect(settings.get("argot.encode.disableAboveTokens")).toBe(-1);
			expect(settings.get("argot.enabled")).toBe(false);
		});
	});

	describe("the migrated value reaches the gate, not just the settings tree", () => {
		/**
		 * THE POINT OF THE WHOLE ROW. A migration that stores the value where nothing reads it is the
		 * same outcome as no migration, so this case takes the legacy config all the way through
		 * `buildArgotGate` (the one home for settings -> gate) and the SDK's own `shouldEncode`
		 * predicate, which is what decides whether a turn teaches shorthand.
		 */
		it("arms the encode gate from a legacy flat config", async () => {
			const settings = await loadWith({ argot: { enabled: true, models: [MODEL] } });

			const gate = buildArgotGate(
				settings.get("argot.enabled") === true,
				(settings.get("argot.encode.models") as string[] | undefined) ?? [],
				settings.get("argot.encode.disableAboveTokens") as number,
			);

			expect(gate.models).toEqual([MODEL]);
			expect(shouldEncode(gate, { model: MODEL, contextTokens: 0 })).toBe(true);
			expect(shouldEncode(gate, { model: OTHER, contextTokens: 0 })).toBe(false);
		});

		/**
		 * And the cutoff, which only shows up above its threshold. Both sides are asserted, because a
		 * cutoff that refused everything would satisfy the "stops above the threshold" half alone.
		 */
		it("carries a legacy cutoff into the gate's context decision", async () => {
			const settings = await loadWith({ argot: { enabled: true, models: [MODEL], disableAboveTokens: 200_000 } });

			const gate = buildArgotGate(
				true,
				(settings.get("argot.encode.models") as string[] | undefined) ?? [],
				settings.get("argot.encode.disableAboveTokens") as number,
			);

			expect(gate.disableAboveTokens).toBe(200_000);
			expect(shouldEncode(gate, { model: MODEL, contextTokens: 199_000 })).toBe(true);
			expect(shouldEncode(gate, { model: MODEL, contextTokens: 201_000 })).toBe(false);
		});
	});
});
