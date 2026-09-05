/**
 * WHY: PTY wrappers and background children previously survived arm completion,
 * contaminating later measurements. Repeated config copies also raised EEXIST.
 * This suite covers process tree termination, timeout bounds, cwd inheritance,
 * colored status row matching, and warm-state retention versus cold reseeding.
 * It does not verify visual settling or provider discovery latency.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { Process, ProcessStatus } from "@veyyon/natives";
import { extractInstalledNatives, ptyWrapper, recordFrame, timeRun } from "./bench-startup";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const directories: string[] = [];

async function scratch(): Promise<string> {
	const parent = path.join(root, ".captures", "bench-startup-tree-tests");
	await mkdir(parent, { recursive: true });
	const directory = await mkdtemp(path.join(parent, "case-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

async function seedTrackingExecutable(directory: string, seed: string): Promise<string> {
	const binary = path.join(directory, "seed-tracker.js");
	await writeFile(path.join(seed, "state.txt"), "0");
	await writeFile(
		binary,
		`#!${process.execPath}
import * as fs from "node:fs";
import * as path from "node:path";
if (process.argv.includes("--version") || process.argv.includes("--help")) {
  const state = path.join(process.env.VEYYON_CONFIG_DIR, "state.txt");
  const previous = Number(fs.readFileSync(state, "utf8"));
  fs.appendFileSync(${JSON.stringify(path.join(directory, "observations.jsonl"))}, JSON.stringify(previous) + "\\n");
  fs.writeFileSync(state, String(previous + 1));
  process.stdout.write("seed-tracker\\n");
}
`,
		{ mode: 0o755 },
	);
	return binary;
}

describe("startup benchmark process tree termination and bounds", () => {
	test("a missing executable reports the spawn error without waiting for the hold deadline", async () => {
		const directory = await scratch();
		const started = performance.now();
		await expect(
			recordFrame(path.join(directory, "missing-executable"), [], {}, 10_000, false, directory),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(performance.now() - started).toBeLessThan(3000);
	});

	test("recordFrame terminates the process tree including background descendants within bounded time", async () => {
		const directory = await scratch();
		const pidFile = path.join(directory, "child.pid");
		const runner = path.join(directory, "runner.sh");
		await writeFile(
			runner,
			`#!/bin/sh
sleep 100 &
echo $! > "${pidFile}"
printf '· \\033[32mAuto\\033[39m ·\\n'
sleep 100
`,
			{ mode: 0o755 },
		);

		const wrapper = ptyWrapper("/bin/sh", [runner]);
		const started = performance.now();
		const marks = await recordFrame(
			wrapper.command,
			wrapper.args,
			{ PATH: process.env.PATH ?? "/usr/bin:/bin" },
			400,
			true,
			directory,
		);

		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(3500);
		expect(marks.statusrow).toBeDefined();

		const childPidStr = await readFile(pidFile, "utf8").catch(() => "");
		const childPid = Number(childPidStr.trim());
		expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
		const childRef = Process.fromPid(childPid);
		expect(childRef?.status() ?? ProcessStatus.Exited).toBe(ProcessStatus.Exited);
	});

	test("timeRun with until=first-byte terminates the process tree immediately upon first byte", async () => {
		const directory = await scratch();
		const pidFile = path.join(directory, "bg.pid");
		const runner = path.join(directory, "first-byte-runner.sh");
		await writeFile(
			runner,
			`#!/bin/sh
sleep 100 &
echo $! > "${pidFile}"
printf 'READY_BYTE'
sleep 100
`,
			{ mode: 0o755 },
		);

		const started = performance.now();
		const outcome = await timeRun(
			"/bin/sh",
			[runner],
			{ PATH: process.env.PATH ?? "/usr/bin:/bin" },
			"first-byte",
			5000,
			directory,
		);

		const elapsed = performance.now() - started;
		expect(elapsed).toBeLessThan(2000);
		expect(outcome.ms).toBeLessThan(1000);
		expect(outcome.stdout).toContain("READY_BYTE");

		const bgPidStr = await readFile(pidFile, "utf8").catch(() => "");
		const bgPid = Number(bgPidStr.trim());
		expect(Number.isSafeInteger(bgPid) && bgPid > 0).toBe(true);
		const bgRef = Process.fromPid(bgPid);
		expect(bgRef?.status() ?? ProcessStatus.Exited).toBe(ProcessStatus.Exited);
	});

	test("timeRun terminates process tree on timeout", async () => {
		const directory = await scratch();
		const pidFile = path.join(directory, "timeout.pid");
		const runner = path.join(directory, "timeout-runner.sh");
		await writeFile(
			runner,
			`#!/bin/sh
sleep 100 &
echo $! > "${pidFile}"
sleep 100
`,
			{ mode: 0o755 },
		);

		await expect(
			timeRun("/bin/sh", [runner], { PATH: process.env.PATH ?? "/usr/bin:/bin" }, "exit", 200, directory),
		).rejects.toThrow("timed out after 200ms");

		const pidStr = await readFile(pidFile, "utf8").catch(() => "");
		const pid = Number(pidStr.trim());
		expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
		const ref = Process.fromPid(pid);
		expect(ref?.status() ?? ProcessStatus.Exited).toBe(ProcessStatus.Exited);
	});
});

describe("startup benchmark cwd inheritance", () => {
	test("timeRun executes inside the specified cwd", async () => {
		const directory = await scratch();
		const outcome = await timeRun(
			process.execPath,
			["-e", "process.stdout.write(process.cwd());"],
			{},
			"exit",
			5000,
			directory,
		);
		expect(outcome.stdout.trim()).toBe(directory);
	});

	test("recordFrame executes inside the specified cwd", async () => {
		const directory = await scratch();
		const targetFile = path.join(directory, "cwd-check.txt");
		const runner = path.join(directory, "cwd-runner.js");
		await writeFile(
			runner,
			`import * as fs from 'node:fs';
fs.writeFileSync('cwd-check.txt', process.cwd());
process.stdout.write('· Auto ·\\n');
`,
		);

		await recordFrame(process.execPath, [runner], {}, 300, false, directory);
		const recordedCwd = await readFile(targetFile, "utf8").catch(() => "");
		expect(recordedCwd.trim()).toBe(directory);
	});

	test("extractInstalledNatives runs probe in specified cwd", async () => {
		const directory = await scratch();
		const probeCwdFile = path.join(directory, "probe-cwd.txt");
		const fakeCli = path.join(directory, "fake-cli.js");
		await writeFile(
			fakeCli,
			`import * as fs from 'node:fs';
import * as path from 'node:path';
if (process.argv.includes('grep')) {
  fs.writeFileSync('${probeCwdFile}', process.cwd());
  const home = process.env.HOME || '';
  const nativesDir = path.join(home, '.veyyon', 'natives');
  fs.mkdirSync(nativesDir, { recursive: true });
}
`,
		);

		const natives = await extractInstalledNatives(directory, process.execPath, [fakeCli], directory);
		expect(natives).toBeDefined();
		const recordedCwd = await readFile(probeCwdFile, "utf8").catch(() => "");
		expect(recordedCwd.trim()).toBe(directory);
	});
});

describe("status marker recognition across colored and fragmented output", () => {
	test("recordFrame recognizes ANSI-colored status row, composer prompt, and echo probe", async () => {
		const directory = await scratch();
		const serverScript = path.join(directory, "card-server.js");
		await writeFile(
			serverScript,
			`
process.stdout.write('\\x1b[2J\\x1b[H\\x1b[90mask ');
process.stdout.write('anything\\x1b[39m\\r\\n');
process.stdout.write('\\x1b[38;2;120;120;120m· \\x1b[38;2;180;180;180mAu');
process.stdout.write('to \\x1b[38;2;120;120;120m·\\x1b[39m\\r\\n');

process.stdin.on('data', chunk => {
  if (chunk.toString().includes('qjq')) {
    process.stdout.write('qjq\\r\\n');
  }
});
`,
		);

		const marks = await recordFrame(process.execPath, [serverScript], {}, 400, true, directory);
		expect(marks.firstByte).toBeDefined();
		expect(marks.composer).toBeDefined();
		expect(marks.statusrow).toBeDefined();
		expect(marks.editable).toBeDefined();
	});
});

describe("benchmark seed copy warm vs cold semantics", () => {
	test("warm run preserves config across multiple arms without EEXIST", async () => {
		const directory = await scratch();
		const seedDir = path.join(directory, "seed");
		const scratchDir = path.join(directory, "bench-run");
		const jsonOut = path.join(directory, "out.json");

		await mkdir(path.join(seedDir, "profiles", "default", "agent"), { recursive: true });
		await writeFile(path.join(seedDir, "config.yml"), "startup:\n  checkUpdate: true\n");
		await writeFile(
			path.join(seedDir, "profiles", "default", "agent", "config.yml"),
			"startup:\n  autoUpdate: true\n",
		);

		const binary = await seedTrackingExecutable(directory, seedDir);

		await exec(
			process.execPath,
			[
				"scripts/bench-startup.ts",
				"--seed",
				seedDir,
				"--bin",
				binary,
				"--runs",
				"2",
				"--only",
				"version,help",
				"--scratch",
				scratchDir,
				"--json",
				jsonOut,
			],
			{ cwd: root },
		);

		const report = JSON.parse(await readFile(jsonOut, "utf8")) as {
			samples: Array<{ arm: string }>;
			home: string;
		};
		expect(report.home).toBe("warm");
		expect(report.samples.filter(s => s.arm === "version").length).toBe(2);
		expect(report.samples.filter(s => s.arm === "help").length).toBe(2);

		const warmedConfig = await readFile(path.join(scratchDir, "config", "config.yml"), "utf8");
		expect(warmedConfig).toContain("checkUpdate: false");
		expect(await readFile(path.join(directory, "observations.jsonl"), "utf8")).toBe("0\n1\n2\n3\n");
		expect(await readFile(path.join(seedDir, "state.txt"), "utf8")).toBe("0");
	});

	test("cold run re-seeds clean config on each arm without collisions", async () => {
		const directory = await scratch();
		const seedDir = path.join(directory, "seed-cold");
		const scratchDir = path.join(directory, "bench-run-cold");
		const jsonOut = path.join(directory, "out-cold.json");

		await mkdir(seedDir, { recursive: true });
		await writeFile(path.join(seedDir, "config.yml"), "startup:\n  checkUpdate: true\n");

		const binary = await seedTrackingExecutable(directory, seedDir);

		await exec(
			process.execPath,
			[
				"scripts/bench-startup.ts",
				"--cold",
				"--seed",
				seedDir,
				"--bin",
				binary,
				"--runs",
				"2",
				"--only",
				"version",
				"--scratch",
				scratchDir,
				"--json",
				jsonOut,
			],
			{ cwd: root },
		);

		const report = JSON.parse(await readFile(jsonOut, "utf8")) as {
			samples: Array<{ arm: string }>;
			home: string;
		};
		expect(report.home).toBe("cold");
		expect(report.samples.filter(s => s.arm === "version").length).toBe(2);
		expect(await readFile(path.join(directory, "observations.jsonl"), "utf8")).toBe("0\n0\n");
		expect(await readFile(path.join(seedDir, "state.txt"), "utf8")).toBe("0");
	});
});
