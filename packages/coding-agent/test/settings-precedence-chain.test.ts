import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getDefault } from "@veyyon/coding-agent/config/settings-schema";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "./helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makeSettingsPrecedenceDir = useTrackedTempDirs("veyyon-settings-precedence-");

/**
 * SETC-6: the Tier-A precedence chain, stated once and proven per layer.
 *
 * Four sources can set the same knob, and a user only ever sees the winner. When
 * precedence is wrong the symptom is not an error, it is "I set that and nothing
 * happened" — the single most expensive kind of config bug to diagnose, because
 * the value the user typed is right there in a file being read and ignored.
 *
 * The chain, lowest to highest:
 *
 *   1. the compiled schema default
 *   2. the global `config.yml` in the agent dir
 *   3. the project layer, `<cwd>/.veyyon/config.yml`
 *   4. `--config` overlays, later files winning over earlier ones
 *   5. runtime overrides: `--set` on the command line, and `set()` in-process
 *
 * Each test adds exactly one layer to the one below it, so a failure names the
 * boundary that broke rather than just "the merge is wrong". The knobs are a
 * table spanning the three value types (boolean, number, string) because the
 * merge walks nested objects and a per-type bug is entirely possible: `false`
 * and `0` are the classic casualties of a `||`-based merge, so both appear here
 * deliberately as HIGH-precedence values overriding truthy lower ones.
 *
 * Deviation from the row as written, recorded rather than papered over: the row
 * described the chain as "default → file → env → CLI", but there is no
 * environment layer in `Settings`. Env vars in this codebase relocate ROOTS
 * (`VEYYON_CONFIG_DIR`, `XDG_CACHE_HOME`) rather than set Tier-A knobs, so there
 * is no env stage to test here. Anything else would be inventing a layer to have
 * something to assert about.
 */
describe("Tier-A settings precedence", () => {
	/**
	 * One knob per value type. Each carries four distinct values so no two layers
	 * can be confused for each other, and every value differs from the compiled
	 * default so "the default leaked through" is always visible.
	 */
	const KNOBS = [
		// Default `true`, so the runtime `false` at the top of the chain is
		// distinguishable from the default leaking through.
		{ path: "git.enabled", type: "boolean", global: true, project: true, overlay: true, runtime: false },
		// Default 3, so no layer's value collides with it.
		{ path: "advisor.immuneTurns", type: "number", global: 11, project: 22, overlay: 33, runtime: 0 },
		// A real enum: every value below is one the schema actually declares, so
		// these tests cannot pass on a value the app would reject.
		{
			path: "statusLine.preset",
			type: "enum",
			global: "minimal",
			project: "compact",
			overlay: "full",
			runtime: "ascii",
		},
	] as const;

	let agentDir = "";
	let cwd = "";

	beforeEach(() => {
		const root = makeSettingsPrecedenceDir();
		agentDir = path.join(root, "agent");
		cwd = path.join(root, "project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(path.join(cwd, ".veyyon"), { recursive: true });
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(path.dirname(agentDir), "settings-precedence-chain"));
			agentDir = "";
			cwd = "";
		}
	});

	/** Write a YAML file expressing `path: value` as the nested mapping it is. */
	function writeLayer(file: string, entries: readonly (readonly [string, unknown])[]): void {
		const tree: Record<string, Record<string, unknown>> = {};
		for (const [dotted, value] of entries) {
			const [group, leaf] = dotted.split(".") as [string, string];
			const groupTree = tree[group] ?? {};
			groupTree[leaf] = value;
			tree[group] = groupTree;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			Object.entries(tree)
				.map(([group, leaves]) => {
					const body = Object.entries(leaves)
						.map(([leaf, value]) => `  ${leaf}: ${JSON.stringify(value)}`)
						.join("\n");
					return `${group}:\n${body}`;
				})
				.join("\n"),
		);
	}

	const globalFile = () => path.join(agentDir, "config.yml");
	const projectFile = () => path.join(cwd, ".veyyon", "config.yml");
	const overlayFile = (name: string) => path.join(cwd, name);

	function load(options: { configFiles?: string[]; overrides?: Record<string, unknown> } = {}) {
		return Settings.loadIsolated({
			agentDir,
			cwd,
			...(options.configFiles ? { configFiles: options.configFiles } : {}),
			...(options.overrides ? { overrides: options.overrides as never } : {}),
		});
	}

	/**
	 * Assert all three knobs at once, naming the one that disagreed.
	 *
	 * Deliberately not `expect(KNOBS.map(k => settings.get(k.path))).toEqual([...])`.
	 * That form reports the whole array on failure without saying which knob moved,
	 * and `settings.get` is typed per literal path, so mapping the table collapses
	 * the three paths into a union whose overload resolves to `never`: the array
	 * assertion never typechecked at all. It passed at runtime, which is exactly why
	 * nobody noticed until a clean typecheck ran.
	 */
	function expectKnobs(
		settings: Awaited<ReturnType<typeof load>>,
		expected: {
			gitEnabled: boolean;
			immuneTurns: number;
			// Drawn from the table rather than typed as `string`, so an expectation can
			// only ever name a preset the schema actually declares.
			preset: (typeof KNOBS)[2]["global" | "project" | "overlay" | "runtime"];
		},
	): void {
		expect(settings.get("git.enabled")).toBe(expected.gitEnabled);
		expect(settings.get("advisor.immuneTurns")).toBe(expected.immuneTurns);
		expect(settings.get("statusLine.preset")).toBe(expected.preset);
	}

	test("with no file anywhere, every knob reads its compiled default", async () => {
		// The floor. Without it, a chain test can pass while the default is never
		// consulted at all, and a knob nobody configured would silently be undefined.
		const settings = await load();

		for (const knob of KNOBS) {
			expect(settings.get(knob.path)).toBe(getDefault(knob.path) as never);
			expect(settings.get(knob.path)).not.toBeUndefined();
		}
	});

	test("the global config wins over the compiled default", async () => {
		writeLayer(
			globalFile(),
			KNOBS.map(k => [k.path, k.global] as const),
		);

		const settings = await load();

		expectKnobs(settings, { gitEnabled: true, immuneTurns: 11, preset: "minimal" });
	});

	test("the project config wins over the global config", async () => {
		// The boundary most likely to be wrong in practice: a per-repo setting that
		// silently loses to the user's global one looks exactly like the repo config
		// not being read at all.
		writeLayer(
			globalFile(),
			KNOBS.map(k => [k.path, k.global] as const),
		);
		writeLayer(
			projectFile(),
			KNOBS.map(k => [k.path, k.project] as const),
		);

		const settings = await load();

		expectKnobs(settings, { gitEnabled: true, immuneTurns: 22, preset: "compact" });
	});

	test("a --config overlay wins over both files", async () => {
		writeLayer(
			globalFile(),
			KNOBS.map(k => [k.path, k.global] as const),
		);
		writeLayer(
			projectFile(),
			KNOBS.map(k => [k.path, k.project] as const),
		);
		writeLayer(
			overlayFile("overlay.yml"),
			KNOBS.map(k => [k.path, k.overlay] as const),
		);

		const settings = await load({ configFiles: [overlayFile("overlay.yml")] });

		expectKnobs(settings, { gitEnabled: true, immuneTurns: 33, preset: "full" });
	});

	test("a later --config overlay wins over an earlier one", async () => {
		// Argument order is the only thing distinguishing two overlays, so it has to
		// be last-wins and it has to be stated somewhere a change would break.
		writeLayer(overlayFile("first.yml"), [["advisor.immuneTurns", 33]]);
		writeLayer(overlayFile("second.yml"), [["advisor.immuneTurns", 44]]);

		const settings = await load({ configFiles: [overlayFile("first.yml"), overlayFile("second.yml")] });

		expect(settings.get("advisor.immuneTurns")).toBe(44);
	});

	test("a runtime override wins over every file layer", async () => {
		// The top of the chain: `--set` on this invocation must beat anything on
		// disk, or a one-off flag would be unusable in a configured repo.
		writeLayer(
			globalFile(),
			KNOBS.map(k => [k.path, k.global] as const),
		);
		writeLayer(
			projectFile(),
			KNOBS.map(k => [k.path, k.project] as const),
		);
		writeLayer(
			overlayFile("overlay.yml"),
			KNOBS.map(k => [k.path, k.overlay] as const),
		);

		const settings = await load({
			configFiles: [overlayFile("overlay.yml")],
			overrides: Object.fromEntries(KNOBS.map(k => [k.path, k.runtime])),
		});

		// `false` and `0` on purpose: a merge written with `||` or a bare
		// falsy-check would drop exactly these two and fall back to the layer below,
		// and every truthy value in the table would still pass.
		expectKnobs(settings, { gitEnabled: false, immuneTurns: 0, preset: "ascii" });
	});

	describe("the layers are independent, not all-or-nothing", () => {
		test("a knob set only in the global file is not erased by an unrelated project setting", async () => {
			// Deep merge, not replace. If the project layer overwrote the global object
			// wholesale, configuring one knob in a repo would silently reset every
			// other knob in that group to its default.
			writeLayer(globalFile(), [
				["git.enabled", true],
				["advisor.immuneTurns", 11],
			]);
			writeLayer(projectFile(), [["advisor.immuneTurns", 22]]);

			const settings = await load();

			expect(settings.get("git.enabled")).toBe(true);
			expect(settings.get("advisor.immuneTurns")).toBe(22);
		});

		test("an overlay that mentions one knob leaves the others on their lower layers", async () => {
			writeLayer(globalFile(), [["git.enabled", true]]);
			writeLayer(projectFile(), [["statusLine.preset", "compact"]]);
			writeLayer(overlayFile("overlay.yml"), [["advisor.immuneTurns", 33]]);

			const settings = await load({ configFiles: [overlayFile("overlay.yml")] });

			expectKnobs(settings, { gitEnabled: true, immuneTurns: 33, preset: "compact" });
		});
	});

	describe("what a missing or unreadable overlay does", () => {
		test("a --config path that does not exist is a hard error, not a silent skip", async () => {
			// Deliberate and load-bearing (Law 10): a typo'd `--config` path silently
			// falling back to the persistent settings would run the session under a
			// configuration the user believes they replaced.
			await expect(load({ configFiles: [overlayFile("nope.yml")] })).rejects.toThrow(/nope\.yml/);
		});

		test("an overlay that is not a YAML mapping is rejected by name", async () => {
			fs.writeFileSync(overlayFile("scalar.yml"), "just a string\n");

			await expect(load({ configFiles: [overlayFile("scalar.yml")] })).rejects.toThrow(/scalar\.yml/);
		});
	});
});
