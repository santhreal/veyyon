/**
 * `/cpu-limit` answers with one fact per line.
 *
 * WHY THIS SUITE EXISTS. The report answers three questions that fail
 * independently — what this session is capped at, what enforcement is actually
 * doing, and what the machine tier across every veyyon is holding — and it used
 * to run all of them together as one paragraph. On a host that cannot delegate
 * a controller the middle answer is itself three sentences with an absolute
 * cgroup path in it, so the machine-wide limit, the one an operator is least
 * expecting to be holding them, arrived at the end of a wrapped block.
 *
 * WHAT THE CLASS IS. Not the one join that was wrong: any fact the report adds
 * later sharing a line with a fact about a different scope. So the assertion is
 * on the SHAPE of the message — each line carries exactly one of the known
 * fact openers, and no line carries two — rather than on a rendered string,
 * which would pass again the moment a fourth scope is appended to a line.
 *
 * WHAT IT DOES NOT CATCH. It says nothing about how a line WRAPS in a narrow
 * terminal: the report hands the host one string per fact and the transcript
 * owns the wrapping. It also says nothing about the settings panel, which
 * renders the same limits as rows and never as prose.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { machineBudgetPlacement, resetSessionCpuLimitsForTests } from "@veyyon/coding-agent/session/cpu-limit";
import { applyCpuLimitCommand } from "@veyyon/coding-agent/slash-commands/helpers/cpu-limit";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import * as YAML from "yaml";
import { makeCgroupRoot, makeDelegatedParent, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";

/**
 * The openers the report is allowed to start a line with, each naming one
 * scope. A fact added to the report without a line of its own shows up here as
 * a line that opens with one of these and contains another.
 */
const FACT_OPENERS: readonly string[] = [
	"Session CPU limit:",
	"Session CPU limit lifted",
	"Session override dropped.",
	"Enforcement:",
	"Machine-wide limit across every veyyon on this machine:",
	"Machine limits: unreadable",
	"Not applied yet:",
	"A machine-wide resource limit is set,",
	"The kernel is holding it.",
	"This session's",
	"That machine limit still applies",
];

let configRoot = "";
let previousConfigDir: string | undefined;

/** Every line of `message`, with the fact opener each one starts with. */
function factLines(message: string): readonly { readonly line: string; readonly opener: string | undefined }[] {
	return message.split("\n").map(line => ({ line, opener: FACT_OPENERS.find(opener => line.startsWith(opener)) }));
}

function writeMachineConfig(cpuLimitCores: number): void {
	fs.writeFileSync(
		path.join(configRoot, "config.yml"),
		YAML.stringify({ machine: { cpuLimitCores, memoryLimitGb: 0, writeBudgetGb: 0, maxProcesses: 0 } }),
	);
}

/** A machine group the kernel can hold, so the report reaches its enforced branch. */
async function placeMachineBudget(delegable: boolean): Promise<void> {
	const root = await makeCgroupRoot();
	const parentDir = await makeDelegatedParent(root, delegable ? {} : { controllers: "" });
	if (delegable) {
		const machineDir = path.join(parentDir, "veyyon.machine");
		fs.mkdirSync(machineDir, { recursive: true });
		fs.writeFileSync(path.join(machineDir, "cgroup.controllers"), "cpu io memory pids");
		fs.writeFileSync(path.join(machineDir, "cgroup.subtree_control"), "");
	}
	await machineBudgetPlacement(makeFakeHost(root).env, parentDir);
}

beforeEach(() => {
	configRoot = path.join(os.tmpdir(), `pi-limit-lines-${Snowflake.next()}`);
	fs.mkdirSync(configRoot, { recursive: true });
	previousConfigDir = process.env.VEYYON_CONFIG_DIR;
	process.env.VEYYON_CONFIG_DIR = configRoot;
	resetSessionCpuLimitsForTests();
});

afterEach(async () => {
	await removeCgroupRoots();
	if (previousConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
	else process.env.VEYYON_CONFIG_DIR = previousConfigDir;
	if (configRoot && fs.existsSync(configRoot)) removeSyncWithRetries(configRoot);
	resetSessionCpuLimitsForTests();
});

/**
 * The shape assertion, run over every branch the report can take: each line is
 * a recognised fact, and no line holds a second one.
 */
async function expectOneFactPerLine(argument: string, sessionCores: number): Promise<string> {
	const settings = Settings.isolated({ "session.cpuLimitCores": sessionCores });

	const result = await applyCpuLimitCommand(argument, settings, null);

	expect(result.ok).toBe(true);
	const lines = factLines(result.message);
	expect(lines.length).toBeGreaterThan(1);
	for (const { line, opener } of lines) {
		expect(opener).toBeDefined();
		const others = FACT_OPENERS.filter(candidate => candidate !== opener && line.includes(candidate));
		expect(others).toEqual([]);
	}
	return result.message;
}

it("keeps the session cap and the machine cap on separate lines", async () => {
	writeMachineConfig(3);

	const message = await expectOneFactPerLine("status", 2);

	expect(message.split("\n")[0]).toStartWith("Session CPU limit: 2 cores");
	expect(message.split("\n")[1]).toStartWith("Machine-wide limit across every veyyon");
});

it("gives the unenforceable verdict its own line rather than trailing the machine cap", async () => {
	writeMachineConfig(3);
	await placeMachineBudget(false);

	const message = await expectOneFactPerLine("status", 2);
	const machineLine = message.split("\n").find(line => line.startsWith("Machine-wide limit")) ?? "";

	// The verdict is a paragraph naming a cgroup path; on the machine line it
	// pushed the cap itself out of the reader's first line of prose.
	expect(machineLine).not.toContain("cannot delegate");
	expect(machineLine.endsWith("cores.")).toBe(true);
	expect(message).toContain("\nA machine-wide resource limit is set,");
});

it("gives the bounded relation its own line under the held machine cap", async () => {
	writeMachineConfig(1);
	await placeMachineBudget(true);

	const message = await expectOneFactPerLine("status", 4);

	expect(message.split("\n")).toContain("The kernel is holding it.");
	expect(message.split("\n")).toContain("This session's 4 cores are bounded by it.");
});

it("keeps the lift confirmation, the machine cap and its consequence on three lines", async () => {
	writeMachineConfig(3);

	const message = await expectOneFactPerLine("lift", 2);
	const lines = message.split("\n");

	expect(lines[0]).toStartWith("Session CPU limit lifted for this session.");
	expect(lines[1]).toStartWith("Machine-wide limit across every veyyon");
	expect(lines.at(-1)).toBe("That machine limit still applies and is set in /settings under Resources.");
	// The lift dropped this session's cap, so nothing of the session's is bounded.
	expect(message).not.toContain("bounded by it");
});

it("keeps the dropped-override confirmation off the report it prints under it", async () => {
	writeMachineConfig(3);

	const message = await expectOneFactPerLine("reset", 2);

	expect(message.split("\n")[0]).toBe("Session override dropped.");
});

/**
 * Non-vacuity: the openers table is what the shape assertion is made of, so a
 * message that opens with none of them has to fail rather than pass silently.
 */
it("rejects a line that opens with no known fact", () => {
	const lines = factLines("Session CPU limit: 2 cores.\nSomething nobody declared.");

	expect(lines[0]?.opener).toBe("Session CPU limit:");
	expect(lines[1]?.opener).toBeUndefined();
});
