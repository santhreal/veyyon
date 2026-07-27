/**
 * `veyyon grievances` e2e: list/clean against a seeded auto-QA SQLite database
 * in a throwaway home. Pins the JSON row shape, tool filtering, the
 * exactly-one-selector rule for clean, and the no-database fallbacks.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("veyyon-grievances-home-");

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

function makeHome(): string {
	return makeTempDir();
}

function makeEnv(home: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete env[key];
	}
	return env;
}

/** Seed the default profile's autoqa.db with the production schema and sample rows. */
function seedDb(home: string): void {
	const configDir = path.join(home, ".veyyon", "profiles", "default");
	mkdirSync(configDir, { recursive: true });
	const db = new Database(path.join(configDir, "autoqa.db"));
	db.run(`
		CREATE TABLE IF NOT EXISTS grievances (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			model TEXT NOT NULL,
			version TEXT NOT NULL,
			tool TEXT NOT NULL,
			report TEXT NOT NULL,
			pushed INTEGER NOT NULL DEFAULT 0
		);
	`);
	const insert = db.prepare("INSERT INTO grievances (model, version, tool, report) VALUES (?, ?, ?, ?)");
	insert.run("test-model", "1.0.0", "find", "find missed a glob");
	insert.run("test-model", "1.0.0", "grep", "grep dropped a match");
	insert.run("test-model", "1.0.0", "grep", "grep mangled unicode");
	db.close();
}

/**
 * Put a DIRECTORY where `autoqa.db` belongs, so opening it fails while the path plainly exists.
 * This is the state the CLI used to describe as "no grievances database found".
 */
function blockDbPath(home: string): string {
	const dbPath = path.join(home, ".veyyon", "profiles", "default", "autoqa.db");
	mkdirSync(dbPath, { recursive: true });
	return dbPath;
}

async function runGrievances(
	env: Record<string, string | undefined>,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", cliPath, "grievances", ...args], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("veyyon grievances", () => {
	it("without a database prints the enable hint (list) and [] (--json)", async () => {
		const env = makeEnv(makeHome());
		const human = await runGrievances(env, []);
		expect(human.exitCode).toBe(0);
		expect(human.stdout).toContain("No grievances database found");
		const json = await runGrievances(env, ["--json"]);
		expect(json.exitCode).toBe(0);
		expect(JSON.parse(json.stdout)).toEqual([]);
	}, 30_000);

	/**
	 * The database exists and cannot be opened, which is not the same as never having enabled auto-QA.
	 * Telling the user to enable a feature they already enabled sends them the wrong way and hides the
	 * fact that their reported tool issues are being dropped, so the message names the path instead.
	 */
	it("with an unopenable database says so, and does not tell you to enable auto-QA", async () => {
		const home = makeHome();
		const dbPath = blockDbPath(home);
		const env = makeEnv(home);

		const human = await runGrievances(env, []);

		expect(human.exitCode).toBe(0);
		expect(human.stdout).toContain("could not be opened");
		expect(human.stdout).toContain(dbPath);
		expect(human.stdout).not.toContain("No grievances database found");
		expect(human.stdout).not.toContain("VEYYON_AUTO_QA=1");
	}, 30_000);

	/**
	 * `--json` output stays machine-parseable: the payload is unchanged and the explanation goes to
	 * stderr, so a script piping stdout into a JSON parser keeps working while a human still sees why
	 * the list is empty.
	 */
	it("keeps --json stdout parseable and explains on stderr", async () => {
		const home = makeHome();
		blockDbPath(home);
		const env = makeEnv(home);

		const json = await runGrievances(env, ["--json"]);

		expect(json.exitCode).toBe(0);
		expect(JSON.parse(json.stdout)).toEqual([]);
		expect(json.stderr).toContain("could not be opened");
		expect(json.stdout).not.toContain("could not be opened");
	}, 30_000);

	/**
	 * `push --json` carries a machine-readable reason, and it must distinguish the two cases too: a
	 * caller retrying on `no_db` after enabling auto-QA would loop forever against a database that is
	 * there and unreadable.
	 */
	it("reports unreadable_db rather than no_db when pushing", async () => {
		const home = makeHome();
		blockDbPath(home);
		const env = makeEnv(home);

		const pushed = await runGrievances(env, ["push", "--json"]);

		expect(pushed.exitCode).toBe(0);
		expect(JSON.parse(pushed.stdout)).toEqual({ pushed: 0, ok: false, skipped: true, reason: "unreadable_db" });
	}, 30_000);

	/** And the absent case still reports `no_db`, so the distinction is a split and not a rename. */
	it("still reports no_db when there is no database at all", async () => {
		const env = makeEnv(makeHome());

		const pushed = await runGrievances(env, ["push", "--json"]);

		expect(pushed.exitCode).toBe(0);
		expect(JSON.parse(pushed.stdout).reason).toBe("no_db");
	}, 30_000);

	it("lists seeded rows newest-first with the full JSON shape, honoring --tool and --limit", async () => {
		const home = makeHome();
		seedDb(home);
		const env = makeEnv(home);

		const all = await runGrievances(env, ["--json"]);
		expect(all.exitCode).toBe(0);
		const rows = JSON.parse(all.stdout) as {
			id: number;
			model: string;
			version: string;
			tool: string;
			report: string;
		}[];
		expect(rows.length).toBe(3);
		expect(rows[0]).toEqual({
			id: 3,
			model: "test-model",
			version: "1.0.0",
			tool: "grep",
			report: "grep mangled unicode",
		});

		const filtered = await runGrievances(env, ["list", "--tool", "grep", "--json"]);
		const grepRows = JSON.parse(filtered.stdout) as { tool: string }[];
		expect(grepRows.length).toBe(2);
		expect(grepRows.every(row => row.tool === "grep")).toBe(true);

		const limited = await runGrievances(env, ["--limit", "1", "--json"]);
		expect((JSON.parse(limited.stdout) as unknown[]).length).toBe(1);
	}, 30_000);

	it("clean requires exactly one selector", async () => {
		const home = makeHome();
		seedDb(home);
		const env = makeEnv(home);
		const none = await runGrievances(env, ["clean"]);
		expect(none.exitCode).toBe(1);
		expect(none.stderr).toContain("exactly one of --id, --tool, or --all");
		const both = await runGrievances(env, ["clean", "--id", "1", "--all"]);
		expect(both.exitCode).toBe(1);
		expect(both.stderr).toContain("mutually exclusive");
		// Neither refusal deleted anything.
		const rows = JSON.parse((await runGrievances(env, ["--json"])).stdout) as unknown[];
		expect(rows.length).toBe(3);
	}, 30_000);

	it("clean --id deletes one row, --tool a tool's rows, --all the rest", async () => {
		const home = makeHome();
		seedDb(home);
		const env = makeEnv(home);

		const byId = await runGrievances(env, ["clean", "--id", "1", "--json"]);
		expect(byId.exitCode).toBe(0);
		expect(JSON.parse(byId.stdout)).toEqual({ deleted: 1 });

		const byTool = await runGrievances(env, ["clean", "--tool", "grep", "--json"]);
		expect(JSON.parse(byTool.stdout)).toEqual({ deleted: 2 });

		const remaining = JSON.parse((await runGrievances(env, ["--json"])).stdout) as unknown[];
		expect(remaining.length).toBe(0);

		const all = await runGrievances(env, ["clean", "--all", "--json"]);
		expect(JSON.parse(all.stdout)).toEqual({ deleted: 0 });
	}, 30_000);
});
