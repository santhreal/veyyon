/**
 * Kernel-enforcement proof for the resource budgets, against the real kernel.
 *
 * ## Why this is a script and not a test
 *
 * `cpu-limit-real-cgroup.test.ts` holds the same assertions and cannot run
 * anywhere. On the host, `bun test` is refused outright by a filesystem check
 * that will not let a test process see a real home. Inside the test sandbox the
 * container mounts `/sys/fs/cgroup` read-only and answers no systemd user bus,
 * so every kernel assertion skips and the file reports green having proved
 * nothing. Making the sandbox able to host cgroups means `--privileged` and a
 * writable cgroup mount, which is the containment the sandbox exists to give.
 *
 * So the proof lives here: an ordinary script, run on a host with cgroup v2
 * delegation, exiting nonzero when a cap does not hold. Run it with
 * `bun run test:cgroup-proof`.
 *
 * ## What it proves, and what nothing else does
 *
 * Every other suite writes control files into a tmpdir, which accepts every
 * byte and enforces none. Four facts need a kernel:
 *
 * 1. A real bash command's child ends up INSIDE the session group. The machine
 *    tier bounds its members, and the only members it ever gets are processes
 *    the shell adopts. Before the two-level delegation fix the session group
 *    was created outside the machine group and four burners under a one-core
 *    machine cap measured 4.81 cores.
 * 2. The machine CPU cap holds a session that has no limit of its own.
 * 3. The kernel throttles rather than merely accounting: `nr_throttled` moves.
 * 4. The machine memory cap KILLS a hog rather than swapping past it. Before
 *    `memory.swap.max` was written alongside `memory.max`, a 256 MB cap let a
 *    hog reach 5,520 MB and pushed 2.9 GB into host swap first.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as YAML from "yaml";
import { executeBash } from "../packages/coding-agent/src/exec/bash-executor";
import { initSessionCpuLimit, probeSessionCpuLimitSupport } from "../packages/coding-agent/src/session/cpu-limit";

const run = promisify(execFile);

/** The machine CPU cap under test, in cores. */
const CPU_CAP_CORES = 1;
/** The machine memory cap under test, in gigabytes. */
const MEMORY_CAP_GB = 0.25;
/** Burners run against the CPU cap. More than the cap, so a miss is obvious. */
const BURNERS = 4;
/** Wall window the burners spin for. Long enough to span 30 quota periods. */
const WINDOW_S = 3;
/** Where the hog gives up: far enough past the cap that no tolerance explains it. */
const HOG_CEILING_MB = MEMORY_CAP_GB * 1024 * 8;

const failures: string[] = [];

function check(name: string, held: boolean, detail: string): void {
	console.log(`${held ? "HELD" : "NOT HELD"}  ${name}  |  ${detail}`);
	if (!held) failures.push(name);
}

function statField(dir: string, field: string): number {
	const stat = fs.readFileSync(path.join(dir, "cpu.stat"), "utf8");
	return Number(new RegExp(`${field} (\\d+)`).exec(stat)?.[1] ?? 0);
}

const probe = await probeSessionCpuLimitSupport();
console.log(`backend: ${probe.backend?.kind ?? "none"}  |  ${probe.detail}`);
if (!probe.supported || probe.backend?.kind !== "direct") {
	console.error(
		`REFUSED: this host cannot host the proof (${probe.detail}). ` +
			`It needs cgroup v2 with a delegated user hierarchy.`,
	);
	process.exit(2);
}
if (probe.detail.includes("hosts one level only")) {
	console.error("REFUSED: this host delegates one level, so the machine tier cannot be proved here.");
	process.exit(2);
}

// The machine limits the way an operator sets them: the global config file.
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vey-cgroup-proof-"));
fs.writeFileSync(
	path.join(configRoot, "config.yml"),
	YAML.stringify({ machine: { cpuLimitCores: CPU_CAP_CORES, memoryLimitGb: MEMORY_CAP_GB, maxProcesses: 64 } }),
);
process.env.VEYYON_CONFIG_DIR = configRoot;

// An UNCAPPED session. Everything below is held by the machine tier or by
// nothing, which is the claim the machine tier makes.
const sessionId = `cgroup-proof-${process.pid}`;
const limiter = await initSessionCpuLimit({
	sessionId,
	cores: 0,
	kill: false,
	onNotice: text => console.log(`NOTICE: ${text}`),
});
let machineDir = "";
try {
	if (!(await limiter.ensureGroup())) {
		console.error("REFUSED: an uncapped session created no group, so nothing sits inside the machine cap.");
		process.exit(2);
	}

	// 1. Adoption. Read after a delay: adoption is a write the parent makes just
	// after spawn, so a child reading its own cgroup at once can win the race
	// and report the pre-adoption directory.
	const placed = await executeBash(
		"python3 -c \"import time; time.sleep(1); print(open('/proc/self/cgroup').read().strip())\"",
		{ sessionKey: sessionId },
	);
	const childCgroup = placed.output.trim();
	const adopted = childCgroup.endsWith(`/${limiter.budgetName}`);
	check("a bash command's child joins the session group", adopted, childCgroup);
	if (!adopted) {
		console.error("Nothing below can be measured: the group has no members.");
		process.exit(1);
	}

	machineDir = childCgroup.replace("0::", "/sys/fs/cgroup").replace(`/${limiter.budgetName}`, "");
	check("the session group sits inside the machine group", path.basename(machineDir) === "veyyon.machine", machineDir);
	check(
		"the machine group carries the configured quota",
		fs.readFileSync(path.join(machineDir, "cpu.max"), "utf8").trim() === `${CPU_CAP_CORES * 100_000} 100000`,
		fs.readFileSync(path.join(machineDir, "cpu.max"), "utf8").trim(),
	);
	check(
		"the machine group caps swap alongside memory",
		fs.readFileSync(path.join(machineDir, "memory.swap.max"), "utf8").trim() === "0",
		`memory.max=${fs.readFileSync(path.join(machineDir, "memory.max"), "utf8").trim()} ` +
			`memory.swap.max=${fs.readFileSync(path.join(machineDir, "memory.swap.max"), "utf8").trim()}`,
	);

	// 2 and 3. The CPU cap, measured by the kernel's own accounting for the
	// group rather than by anything the burners report about themselves.
	const burner = `python3 -c "import time
t = time.time()
while time.time() - t < ${WINDOW_S}: pass" &`;
	const beforeUsage = statField(machineDir, "usage_usec");
	const beforeThrottled = statField(machineDir, "nr_throttled");
	const started = Date.now();
	await executeBash(`${burner.repeat(BURNERS)} wait`, { sessionKey: sessionId, timeout: 60_000 });
	const wallS = (Date.now() - started) / 1000;
	const spentS = (statField(machineDir, "usage_usec") - beforeUsage) / 1e6;
	const throttled = statField(machineDir, "nr_throttled") - beforeThrottled;
	const cores = spentS / wallS;
	check(
		`the machine CPU cap bounds an uncapped session (${BURNERS} burners, cap ${CPU_CAP_CORES})`,
		cores <= CPU_CAP_CORES * 1.2,
		`${spentS.toFixed(2)}s over ${wallS.toFixed(2)}s wall = ${cores.toFixed(2)} cores`,
	);
	check("the kernel throttles rather than only accounting", throttled > 0, `${throttled} throttled periods`);

	// 4. The memory cap. A resident cap with a swap escape does not kill: it
	// reclaims, swaps, and lets the hog keep growing.
	const hog = await executeBash(
		`python3 -c "
blocks = []
mb = 0
while mb < ${HOG_CEILING_MB}:
    blocks.append(bytearray(8 * 1024 * 1024))
    mb += 8
    print('mb', mb, flush=True)
print('SURVIVED', flush=True)"`,
		{ sessionKey: sessionId, timeout: 120_000 },
	);
	const reachedMb = Number([...hog.output.matchAll(/mb (\d+)/g)].at(-1)?.[1] ?? 0);
	const capMb = MEMORY_CAP_GB * 1024;
	check(
		`the machine memory cap kills instead of swapping past it (cap ${capMb} MB)`,
		!hog.output.includes("SURVIVED") && reachedMb < capMb * 2,
		`hog reached ${reachedMb} MB`,
	);
} finally {
	await limiter.dispose();
	fs.rmSync(configRoot, { recursive: true, force: true });
	if (machineDir) await run("rmdir", [machineDir]).catch(() => undefined);
}

console.log(failures.length === 0 ? "\nPROOF PASSED" : `\nPROOF FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
