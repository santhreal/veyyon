/**
 * `veyyon __complete <kind>` — the hidden helper every generated completion
 * script calls for candidates it cannot bake in.
 *
 * This runs the real CLI rather than the functions behind it, because the
 * contract that matters is a wire format: one `value<TAB>description` line per
 * candidate on stdout, nothing else, fast enough to sit under a TAB press. A
 * unit test of the formatter would not catch an import that drags the agent
 * boot in, or a stray log line that becomes a completion candidate.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const { env, cleanup } = hermeticSpawnEnv();
afterAll(cleanup);

interface Run {
	stdout: string;
	stderr: string;
	exitCode: number;
	/** Candidate values only, with the description field dropped. */
	values: string[];
}

async function complete(...args: string[]): Promise<Run> {
	const proc = Bun.spawn([process.execPath, cliEntry, "__complete", ...args], {
		cwd: repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const values = stdout
		.split("\n")
		.filter(line => line.length > 0)
		.map(line => line.split("\t")[0]);
	return { stdout, stderr, exitCode, values };
}

describe("__complete settings", () => {
	it("offers real setting keys, not a guess at them", async () => {
		// The schema is where a setting is declared, so completion cannot drift
		// from what `config set` accepts.
		const { values } = await complete("settings");
		expect(values).toContain("startup.autoUpdate");
		expect(values).toContain("startup.checkUpdate");
		expect(values).toContain("tools.approvalMode");
	});

	it("narrows by leading path, not by substring", async () => {
		// A setting is a dotted path typed from the left. Substring matching turned
		// `up` into forty unrelated keys where `startup.` gives six and an answer.
		const { values } = await complete("settings", "--", "startup.");
		expect(values).toContain("startup.quiet");
		expect(values.every(v => v.startsWith("startup."))).toBe(true);
	});

	it("returns nothing, quietly, for a prefix that matches no setting", async () => {
		const { stdout, exitCode } = await complete("settings", "--", "definitely-not-a-setting");
		expect(stdout).toBe("");
		expect(exitCode).toBe(0);
	});

	it("carries the description the settings panel shows", async () => {
		// The tooltip a shell displays should say what the UI says; two wordings
		// for one setting is two places to keep right.
		//
		// Read from the schema rather than pinned as a literal, because a literal
		// here IS the second place. It made this suite fail the moment the wording
		// was improved, which teaches the wrong lesson: that editing a description
		// breaks a test, rather than that the two must agree. Now the assertion is
		// the agreement itself, and it can never go stale.
		const expected = SETTINGS_SCHEMA["startup.autoUpdate"].ui?.description;
		expect(expected, "startup.autoUpdate should carry a UI description to complete with").toBeTruthy();

		const { stdout } = await complete("settings", "--", "startup.autoUpdate");
		const [key, description] = stdout.trim().split("\t");

		expect(key).toBe("startup.autoUpdate");
		expect(description).toBe(expected);
	});

	it("emits exactly one line per candidate, with no stray output", async () => {
		// Every line becomes a candidate. A log line, a warning or a banner would
		// be offered to the user as a setting name.
		const { stdout, stderr } = await complete("settings", "--", "startup.");
		expect(stderr).toBe("");
		for (const line of stdout.split("\n").filter(Boolean)) {
			expect(line.split("\t")).toHaveLength(2);
		}
	});
});

describe("__complete setting-values", () => {
	it("offers true and false for a boolean setting", async () => {
		const { values } = await complete("setting-values", "startup.autoUpdate");
		expect(values).toEqual(["true", "false"]);
	});

	it("offers the declared list for an enumerated setting", async () => {
		const { values } = await complete("setting-values", "tools.approvalMode");
		expect(values.length).toBeGreaterThan(1);
		expect(new Set(values).size).toBe(values.length);
	});

	it("offers nothing for a free-form setting", async () => {
		// A number or free string has no candidates. Offering the key's own name,
		// or the word `value`, would be worse than silence.
		const { stdout } = await complete("setting-values", "compaction.thresholdPercent");
		expect(stdout).toBe("");
	});

	it("offers nothing for a key that is not a setting", async () => {
		// The shell passes whatever word precedes the cursor, which is often not a
		// setting at all.
		const { stdout, exitCode } = await complete("setting-values", "not.a.setting");
		expect(stdout).toBe("");
		expect(exitCode).toBe(0);
	});

	it("filters by the prefix already typed", async () => {
		const { values } = await complete("setting-values", "startup.autoUpdate", "--", "t");
		expect(values).toEqual(["true"]);
	});
});

describe("__complete with a kind nobody serves", () => {
	it("says so and exits non-zero instead of looking like no matches", async () => {
		// Law 10: an unknown kind producing empty output on exit 0 is
		// indistinguishable from a kind that simply found nothing, which is exactly
		// the state someone debugging empty completions is trying to tell apart.
		const { stdout, stderr, exitCode } = await complete("nonsense");
		expect(stdout).toBe("");
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain('unknown completion kind "nonsense"');
		expect(stderr).toContain("settings");
	});

	it("names the missing kind rather than printing a bare usage line", async () => {
		const { stderr, exitCode } = await complete();
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("unknown completion kind (missing)");
	});
});
