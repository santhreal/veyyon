import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { removeWithRetries } from "@veyyon/utils";
import * as YAML from "yaml";
import { guardDestructivePath } from "../../utils/test/helpers/destructive-guard";

/**
 * SETC-3: writing one setting must not delete the rest of the user's config.
 *
 * The save path re-reads the file under a lock and applies only the paths this
 * session modified, precisely so that keys it does not know about survive. That
 * design is load-bearing in three situations a user will actually hit:
 *
 *  - they downgrade after using a newer build, and the newer build's keys must
 *    still be there when they upgrade again,
 *  - two veyyon sessions are open and each writes a different setting,
 *  - they hand-edited the file with a comment or a key veyyon has since renamed.
 *
 * A settings writer that serializes its own in-memory view instead would silently
 * delete all three, and the loss would be invisible until the user looked for a
 * setting that used to be set. This suite exists so that a refactor toward
 * "just write the object we have" fails immediately rather than in a bug report
 * months later.
 *
 * Everything is asserted against the real file on disk, parsed back with YAML,
 * because the property is about bytes that survive a write and nothing about the
 * in-memory view can prove that.
 */
describe("writing a setting preserves everything else in the file", () => {
	let agentDir = "";

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-settings-preserve-"));
	});

	afterEach(async () => {
		if (agentDir) {
			await removeWithRetries(guardDestructivePath(agentDir, "settings-unknown-key-preservation"));
			agentDir = "";
		}
	});

	function configPath(): string {
		return path.join(agentDir, "config.yml");
	}

	function writeConfig(contents: string): void {
		fs.writeFileSync(configPath(), contents);
	}

	function readConfig(): Record<string, unknown> {
		return YAML.parse(fs.readFileSync(configPath(), "utf8")) as Record<string, unknown>;
	}

	/** Load a persisted instance pointed at the temp dir, change one setting, flush. */
	async function setAndFlush(settingPath: string, value: unknown): Promise<void> {
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		// biome-ignore lint/suspicious/noExplicitAny: the test drives arbitrary paths by design
		settings.set(settingPath as any, value as any);
		await settings.flush();
	}

	describe("keys this build does not recognize", () => {
		test("an unknown top-level key survives a write to a different setting", async () => {
			// The downgrade case: a newer build wrote `futureFeature`, the user rolls
			// back, and the older build must not eat it.
			writeConfig(YAML.stringify({ futureFeature: { enabled: true, mode: "aggressive" } }));

			await setAndFlush("theme", "titanium");

			const after = readConfig();
			// The exact nested value, not merely the key's presence: a shallow merge that
			// replaced the object with `{}` would still leave the key behind.
			expect(after.futureFeature).toEqual({ enabled: true, mode: "aggressive" });
			expect(after.theme).toBe("titanium");
		});

		test("an unknown key nested under a known section survives", async () => {
			// Harder than the top-level case, because writing a sibling under the same
			// section is where a naive `setByPath` on a fresh object loses data.
			writeConfig(YAML.stringify({ startup: { autoUpdate: false, unknownStartupKey: "keep-me" } }));

			await setAndFlush("startup.autoUpdate", true);

			const after = readConfig();
			const startup = after.startup as Record<string, unknown>;
			expect(startup.unknownStartupKey).toBe("keep-me");
			expect(startup.autoUpdate).toBe(true);
		});

		test("several unrelated keys all survive one write", async () => {
			writeConfig(
				YAML.stringify({
					someOldKey: 42,
					anotherOldKey: ["a", "b"],
					deeply: { nested: { value: "intact" } },
				}),
			);

			await setAndFlush("theme", "titanium");

			const after = readConfig();
			expect(after.someOldKey).toBe(42);
			expect(after.anotherOldKey).toEqual(["a", "b"]);
			expect(after.deeply).toEqual({ nested: { value: "intact" } });
		});
	});

	describe("changes made by another process while this one was running", () => {
		test("a key written externally after load is not clobbered by our save", async () => {
			// Two sessions open at once. The save re-reads under a lock for exactly this
			// reason, and without it the second writer silently reverts the first.
			writeConfig(YAML.stringify({ theme: "titanium" }));
			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			// Another process writes a DIFFERENT setting after we loaded.
			writeConfig(YAML.stringify({ theme: "titanium", externalKey: "written-by-someone-else" }));

			// biome-ignore lint/suspicious/noExplicitAny: driving a path literal
			settings.set("startup.autoUpdate" as any, false as any);
			await settings.flush();

			const after = readConfig();
			expect(after.externalKey).toBe("written-by-someone-else");
			expect((after.startup as Record<string, unknown>).autoUpdate).toBe(false);
		});

		test("an external change to a key we did NOT modify wins over our stale copy", async () => {
			// The precedence that makes the previous test meaningful: we hold a stale
			// value in memory, and because we never modified it, the file's newer value
			// must be the one that survives.
			writeConfig(YAML.stringify({ theme: "titanium" }));
			const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });

			writeConfig(YAML.stringify({ theme: "ember" }));

			// biome-ignore lint/suspicious/noExplicitAny: driving a path literal
			settings.set("startup.autoUpdate" as any, false as any);
			await settings.flush();

			// The external value wins, in the shape the loader migrates a bare theme
			// string into. Both halves are asserted deliberately: the VALUE proves the
			// external write survived, and the SHAPE pins that a legacy `theme: <name>`
			// is normalized to a per-mode object rather than being left ambiguous.
			expect(readConfig().theme).toEqual({ dark: "ember" });
		});
	});

	describe("the file stays valid", () => {
		test("the written file parses as YAML and holds both old and new keys", async () => {
			// A truncated or interleaved write would fail here before any key-level
			// assertion could run, which is why the parse itself is the first check.
			writeConfig(YAML.stringify({ preexisting: "value" }));

			await setAndFlush("theme", "titanium");

			const text = fs.readFileSync(configPath(), "utf8");
			expect(() => YAML.parse(text)).not.toThrow();
			const after = YAML.parse(text) as Record<string, unknown>;
			expect(after.preexisting).toBe("value");
			expect(after.theme).toBe("titanium");
		});

		test("writing to an empty config file creates only the key that was set", async () => {
			// The first-run case. It must not materialize the entire default tree into
			// the file, which would freeze today's defaults forever and make every later
			// default change invisible to this user.
			writeConfig("");

			await setAndFlush("theme", "titanium");

			const after = readConfig();
			expect(Object.keys(after)).toEqual(["theme"]);
		});

		test("two sequential writes accumulate rather than replacing each other", async () => {
			writeConfig(YAML.stringify({ original: "kept" }));

			await setAndFlush("theme", "titanium");
			await setAndFlush("startup.autoUpdate", false);

			const after = readConfig();
			expect(after.original).toBe("kept");
			// Migrated shape, because the second load read back the string this suite's
			// first write produced and normalized it.
			expect(after.theme).toEqual({ dark: "titanium" });
			expect((after.startup as Record<string, unknown>).autoUpdate).toBe(false);
		});
	});
});
