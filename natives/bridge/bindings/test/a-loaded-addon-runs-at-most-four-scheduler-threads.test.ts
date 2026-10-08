import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

/**
 * WHY: napi-rs builds its default Tokio runtime while it registers the addon's exports, with one
 * scheduler worker per CPU spawned at once, so a 32-thread host held 32 idle `tokio-rt-worker`
 * threads for the life of every process that loaded the addon. `__veyyonInstallTokioRuntime`
 * replaces that runtime with one capped at four workers right after the load, before any async
 * native runs. The defect class is any load path that leaves more scheduler workers alive than the
 * cap: the post-load install recording a runtime napi-rs never adopts (the default keeps running
 * beside it), the cap not applied on a platform, or the swap leaving no runtime for async exports.
 *
 * The probe runs in a fresh child, so the addon loads through the production loader exactly once,
 * calls an async export that runs on the runtime and spawns no blocking-pool thread, then counts
 * the threads Tokio named. The count must settle at `min(CPUs, 4)` within two seconds, which also
 * waits out the background shutdown of the replaced runtime. A command then runs through `Shell`
 * to prove async exports still work on the swapped runtime.
 *
 * Gap: on a host with four or fewer CPUs the default runtime also has `min(CPUs, 4)` workers, so
 * there the count cannot tell a missing swap from a working one. Thread names come from
 * `/proc/self/task`, so the suite runs on Linux only.
 */

const INDEX_URL = `file://${path.resolve(import.meta.dir, "..", "native", "index.js")}`;
const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..");
const CAP = 4;

const PROBE = `
import * as fs from "node:fs";
import { Shell } from ${JSON.stringify(INDEX_URL)};
const workers = () =>
	fs.readdirSync("/proc/self/task").filter(t => {
		try { return fs.readFileSync("/proc/self/task/" + t + "/comm", "utf8").trim() === "tokio-rt-worker"; }
		catch { return false; }
	}).length;
const shell = new Shell();
await shell.abort();
const expected = Number(process.argv.at(-1));
const deadline = performance.now() + 2000;
let count = workers();
while (count !== expected && performance.now() < deadline) {
	await new Promise(resolve => setTimeout(resolve, 10));
	count = workers();
}
let output = "";
const result = await shell.run({ command: "echo swapped", cwd: process.cwd() }, (_error, chunk) => { output += chunk; });
console.log(JSON.stringify({ count, exitCode: result.exitCode, output }));
`;

interface ProbeReport {
	count: number;
	exitCode: number;
	output: string;
}

async function probe(expected: number): Promise<ProbeReport> {
	const proc = Bun.spawn([process.execPath, "-e", PROBE, String(expected)], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(`probe exited ${exitCode}: ${stderr}`);
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as ProbeReport;
}

describe.skipIf(process.platform !== "linux")("the addon's Tokio runtime", () => {
	it("settles at min(CPUs, 4) scheduler workers after the first async export", async () => {
		const expected = Math.min(os.availableParallelism(), CAP);
		const report = await probe(expected);
		expect(report.count).toBe(expected);
	});

	it("runs a shell command on the runtime it swapped in", async () => {
		const report = await probe(Math.min(os.availableParallelism(), CAP));
		expect(report.exitCode).toBe(0);
		expect(report.output).toBe("swapped\n");
	});
});
