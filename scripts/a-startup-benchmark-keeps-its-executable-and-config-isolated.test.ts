/**
 * WHY: background updates replaced comparison binaries with one release, producing
 * plausible timings for identical code. Exercise copied config and the benchmark
 * process against in-place and atomic executable replacement. This does not prove
 * startup performance or detect a replacement restored before the final digest.
 *
 * A bench started from a veyyon session inherited `VEYYON_CODING_AGENT_DIR`, so every
 * measured launch loaded the caller's profile: its model roles, its credentials and the
 * network discovery an unresolvable role triggers, while the seeded home went unread.
 * The directory-override sweep covers every spawn site the version and frame arms reach
 * (the natives probe, `timeRun`, `recordFrame`). It does not cover the settled and
 * responsive arms, which build their child environment from nothing.
 */
import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { DIR_OVERRIDE_ENV_KEYS } from "@veyyon/utils";
import { parseDocument } from "yaml";
import { disableBenchmarkUpdates } from "./bench-startup";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const directories: string[] = [];

async function scratch(): Promise<string> {
	const parent = path.join(root, ".captures", "benchmark-isolation-tests");
	await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(path.join(parent, "case-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

test.each([
	"",
	"startup:\n  checkUpdate: true\n  autoUpdate: true\n  quiet: false\nmodelRoles:\n  default: study/model\n",
])("disables both update controls while preserving other seed values: %j", async source => {
	const directory = await scratch();
	const file = path.join(directory, "config.yml");
	if (source) await writeFile(file, source);
	await disableBenchmarkUpdates(file);
	const config = parseDocument(await readFile(file, "utf8"));
	expect(config.getIn(["startup", "checkUpdate"])).toBe(false);
	expect(config.getIn(["startup", "autoUpdate"])).toBe(false);
	if (source) {
		expect(config.getIn(["startup", "quiet"])).toBe(false);
		expect(config.getIn(["modelRoles", "default"])).toBe("study/model");
	}
});

test("rejects malformed seed YAML without rewriting it", async () => {
	const directory = await scratch();
	const file = path.join(directory, "config.yml");
	const source = "startup: [unterminated\n";
	await writeFile(file, source);
	await expect(disableBenchmarkUpdates(file)).rejects.toThrow("Invalid benchmark config");
	expect(await readFile(file, "utf8")).toBe(source);
});

test.each(["unchanged", "append", "replace"] as const)(
	"measures only unchanged executable bytes and preserves the supplied binary: %s",
	async mutation => {
		const directory = await scratch();
		const binary = path.join(directory, "study-cli");
		const result = path.join(directory, "result.json");
		const source = `#!${process.execPath}
import * as fs from 'node:fs';
if (process.argv.includes('--version')) {
  const file = process.argv[1];
  if (${JSON.stringify(mutation)} === 'append') fs.appendFileSync(file, '\\n// updated\\n');
  if (${JSON.stringify(mutation)} === 'replace') {
    fs.writeFileSync(file + '.new', fs.readFileSync(file, 'utf8') + '\\n// updated\\n', { mode: 0o755 });
    fs.renameSync(file + '.new', file);
  }
  process.stdout.write('study 1.0.0\\n');
}
`;
		await writeFile(binary, source, { mode: 0o755 });
		const run = exec(
			process.execPath,
			[
				"scripts/bench-startup.ts",
				"--only",
				"version",
				"--runs",
				"1",
				"--bin",
				binary,
				"--scratch",
				path.join(directory, "run"),
				"--json",
				result,
			],
			{ cwd: root, timeout: 20_000 },
		);
		if (mutation === "unchanged") {
			await run;
			const report: { binarySha256: string; samples: Array<{ arm: string }> } = JSON.parse(
				await readFile(result, "utf8"),
			);
			expect(report.binarySha256).toBe(createHash("sha256").update(source).digest("hex"));
			expect(report.samples.map(sample => sample.arm)).toEqual(["version"]);
		} else {
			await expect(run).rejects.toThrow("Benchmark executable changed during measurement");
			await expect(readFile(result)).rejects.toMatchObject({ code: "ENOENT" });
		}
		expect(await readFile(binary, "utf8")).toBe(source);
	},
	30_000,
);

test("launches every measured child without the caller's directory overrides", async () => {
	const directory = await scratch();
	const binary = path.join(directory, "study-cli");
	const record = path.join(directory, "launches.jsonl");
	const inherited: Record<string, string> = {
		VEYYON_CODING_AGENT_DIR: path.join(directory, "caller-agent"),
		VEYYON_PROFILE: "caller",
		VEYYON_CONFIG_DIR: ".veyyon-caller",
	};
	// A new override key turns this red until it has an inherited value to leak.
	expect(Object.keys(inherited).sort()).toEqual([...DIR_OVERRIDE_ENV_KEYS].sort());
	await writeFile(
		binary,
		`#!${process.execPath}
import * as fs from 'node:fs';
const env = ${JSON.stringify(DIR_OVERRIDE_ENV_KEYS)}.map(key => process.env[key] ?? null);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ arg: process.argv[2] ?? null, env }) + '\\n');
process.stdout.write('study 1.0.0\\n');
`,
		{ mode: 0o755 },
	);
	await exec(
		process.execPath,
		[
			"scripts/bench-startup.ts",
			"--only",
			"version,frame",
			"--runs",
			"1",
			"--bin",
			binary,
			"--scratch",
			path.join(directory, "run"),
		],
		{ cwd: root, timeout: 25_000, env: { ...process.env, HOME: directory, ...inherited } },
	);
	const launches: Array<{ arg: string | null; env: Array<string | null> }> = (await readFile(record, "utf8"))
		.trim()
		.split("\n")
		.map(line => JSON.parse(line));
	expect(launches.map(launch => launch.arg)).toEqual(["grep", "--version", null]);
	// The bench seeds `VEYYON_PROFILE` as the default profile; every other override is absent.
	const seeded = DIR_OVERRIDE_ENV_KEYS.map(key => (key === "VEYYON_PROFILE" ? "" : null));
	for (const launch of launches) expect(launch.env).toEqual(seeded);
}, 30_000);
