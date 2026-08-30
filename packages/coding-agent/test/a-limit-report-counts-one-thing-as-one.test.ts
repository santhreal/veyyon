/**
 * A resource-limit report says `1 core`, never `1 core(s)`.
 *
 * WHY THIS SUITE EXISTS. Every count in the two resource tiers was written as
 * `${n} core(s)` / `${n} process(es)`, which is a placeholder for the plural
 * rule rather than the plural rule: the reader is handed the branch and asked
 * to take it. Nine surfaces printed it — the `/cpu-limit` report at both
 * scopes, the palette row that previews the command, the limiter's own status
 * line, the spawn refusal and the two kill notices — and each carried its own
 * copy of the phrase, so a fix at one left eight.
 *
 * WHAT THE CLASS IS. Not the one sentence in the report: any count a limit
 * surface prints with a hardcoded plural label. The counts now route through
 * `formatCount` in `@veyyon/utils`, which is the single owner of `"3 cores"`
 * and `"1 core"`, so a new sentence is correct by construction and a new
 * hand-rolled label is what this suite is looking for.
 *
 * HOW IT LOOKS FOR IT. The report is swept over the cross product of its
 * inputs — session cores off/one/many, kill on and off, machine tier absent,
 * one and many, cores and processes — and every produced message is checked
 * for a parenthetical plural anywhere in it, then for the singular and plural
 * spellings at one and at many. A branch added to the report is swept by that
 * cross product without being named here, which is the point: the assertion is
 * on the whole message, not on the sentence that had the defect.
 *
 * WHAT IT DOES NOT CATCH. The saturation refusal and the two kill notices are
 * produced by the watcher deciding a budget was exceeded, which needs a live
 * cgroup; `session-resource-limits` and `cpu-limit-real-cgroup` reach those,
 * and their expectations carry the same spelling. It also says nothing about
 * the eval harnesses and repo scripts, which print their own `(s)` and are not
 * operator-facing product surfaces.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { setSettingsInstance } from "@veyyon/coding-agent/config/settings-instance";
import { probeCpuLimitSupport } from "@veyyon/coding-agent/session/cgroup-host";
import {
	type CpuBudgetGroupHandle,
	machineBudgetPlacement,
	resetSessionCpuLimitsForTests,
	SessionCpuLimit,
} from "@veyyon/coding-agent/session/cpu-limit";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import { applyCpuLimitCommand } from "@veyyon/coding-agent/slash-commands/helpers/cpu-limit";
import type { TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import * as YAML from "yaml";
import { makeCgroupRoot, makeDelegatedParent, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";

/** `2 core(s)`, `5 process(es)`, `1 file(s)` — a count that left its plural rule to the reader. */
const PARENTHETICAL_PLURAL = /\b\w+\((?:e)?s\)/;

/** The machine tier this run reports, or none of it. */
interface MachineTier {
	readonly label: string;
	readonly cpuLimitCores: number;
	readonly maxProcesses: number;
}

const MACHINE_TIERS: readonly MachineTier[] = [
	{ label: "no machine tier", cpuLimitCores: 0, maxProcesses: 0 },
	{ label: "one core and one process", cpuLimitCores: 1, maxProcesses: 1 },
	{ label: "many cores and many processes", cpuLimitCores: 4, maxProcesses: 6 },
];

const SESSION_CORES: readonly number[] = [0, 1, 3];

let configRoot = "";
let previousConfigDir: string | undefined;

function writeMachineConfig(tier: MachineTier): void {
	fs.writeFileSync(
		path.join(configRoot, "config.yml"),
		YAML.stringify({
			machine: {
				cpuLimitCores: tier.cpuLimitCores,
				memoryLimitGb: 0,
				writeBudgetGb: 0,
				maxProcesses: tier.maxProcesses,
			},
		}),
	);
}

beforeEach(() => {
	configRoot = path.join(os.tmpdir(), `pi-limit-plural-${Snowflake.next()}`);
	fs.mkdirSync(configRoot, { recursive: true });
	previousConfigDir = process.env.VEYYON_CONFIG_DIR;
	process.env.VEYYON_CONFIG_DIR = configRoot;
	resetSessionCpuLimitsForTests();
});

afterEach(async () => {
	await removeCgroupRoots();
	setSettingsInstance(null);
	if (previousConfigDir === undefined) delete process.env.VEYYON_CONFIG_DIR;
	else process.env.VEYYON_CONFIG_DIR = previousConfigDir;
	if (configRoot && fs.existsSync(configRoot)) removeSyncWithRetries(configRoot);
	resetSessionCpuLimitsForTests();
});

describe("the /cpu-limit report over every input it accepts", () => {
	for (const tier of MACHINE_TIERS) {
		for (const cores of SESSION_CORES) {
			for (const kill of [false, true]) {
				it(`spells its counts with ${tier.label}, ${cores} session cores, kill ${kill ? "on" : "off"}`, async () => {
					writeMachineConfig(tier);
					const settings = Settings.isolated({ "session.cpuLimitCores": cores, "session.cpuLimitKill": kill });

					const status = await applyCpuLimitCommand("status", settings, null);
					const lift = await applyCpuLimitCommand("lift", settings, null);

					for (const message of [status.message, lift.message]) {
						expect(message).not.toMatch(PARENTHETICAL_PLURAL);
					}
					// The session head names its own cap; `lift` has replaced it with
					// zero by the time it reports, so only `status` shows the number.
					if (cores === 1) {
						expect(status.message).toContain("1 core,");
						expect(status.message).not.toContain("1 cores");
					}
					if (cores > 1) expect(status.message).toContain(`${cores} cores,`);
					// Both reports carry the machine tier, so its counts are asserted on
					// each of them rather than on the one that happened to have them.
					for (const message of [status.message, lift.message]) {
						if (tier.cpuLimitCores === 1) {
							expect(message).toContain("1 core");
							expect(message).not.toContain("1 cores");
						}
						if (tier.cpuLimitCores > 1) expect(message).toContain(`${tier.cpuLimitCores} cores`);
						if (tier.maxProcesses === 1) {
							expect(message).toContain("1 process");
							expect(message).not.toContain("1 processes");
						}
						if (tier.maxProcesses > 1) expect(message).toContain(`${tier.maxProcesses} processes`);
					}
				});
			}
		}
	}

	/**
	 * A session cap can only be bounded by a machine cap below it, so the
	 * sentence that relates the two numbers is reachable at two cores and never
	 * at one. It is swept for the plural spelling of the larger number.
	 */
	it("relates a bounded session cap to the machine cap in the plural", async () => {
		writeMachineConfig({ label: "bounding", cpuLimitCores: 1, maxProcesses: 0 });
		const root = await makeCgroupRoot();
		const parentDir = await makeDelegatedParent(root);
		const machineDir = path.join(parentDir, "veyyon.machine");
		fs.mkdirSync(machineDir, { recursive: true });
		fs.writeFileSync(path.join(machineDir, "cgroup.controllers"), "cpu io memory pids");
		fs.writeFileSync(path.join(machineDir, "cgroup.subtree_control"), "");
		await machineBudgetPlacement(makeFakeHost(root).env, parentDir);

		const result = await applyCpuLimitCommand("status", Settings.isolated({ "session.cpuLimitCores": 3 }), null);

		expect(result.message).toContain("This session's 3 cores are bounded by it");
		expect(result.message).not.toMatch(PARENTHETICAL_PLURAL);
	});
});

describe("the palette row that previews /cpu-limit", () => {
	// An isolated instance holds its values as runtime overrides, which is the
	// state the row calls `session` — the same words a `/cpu-limit lift` leaves
	// behind, and the only one this row can be driven into without a profile.
	const previewCores = (cores: number): string | undefined => {
		setSettingsInstance(Settings.isolated({ "session.cpuLimitCores": cores }));
		const command = BUILTIN_SLASH_COMMAND_DEFS.find(candidate => candidate.name === "cpu-limit");
		// This row reads the settings singleton and nothing off the runtime, so the
		// runtime it is handed is a stand-in the closure never touches.
		const runtime = {} as unknown as TuiSlashCommandRuntime;
		return command?.getTuiAutocompleteDescription?.(runtime);
	};

	it("counts one core as one", () => {
		const row = previewCores(1);

		expect(row).toBe("Session CPU budget · 1 core, session");
		expect(row).not.toMatch(PARENTHETICAL_PLURAL);
	});

	it("counts many cores in the plural", () => {
		expect(previewCores(4)).toBe("Session CPU budget · 4 cores, session");
	});

	it("says off rather than counting zero", () => {
		expect(previewCores(0)).toBe("Session CPU budget · off");
	});
});

describe("the limiter's own status line", () => {
	const handle: CpuBudgetGroupHandle = {
		throttles: true,
		adopt: () => {},
		usageUsec: () => 0,
		throttledPeriods: () => 0,
		members: () => [],
		setCores: () => {},
		renice: () => {},
		dispose: () => {},
	};

	async function limiterAt(cores: number, createGroup: () => CpuBudgetGroupHandle): Promise<SessionCpuLimit> {
		const root = await makeCgroupRoot();
		await makeDelegatedParent(root);
		const host = makeFakeHost(root);
		const probe = await probeCpuLimitSupport(host.env);
		return new SessionCpuLimit({
			sessionId: "sess-plural",
			cores,
			kill: false,
			probe,
			env: host.env,
			createGroup,
			windowSamples: 3,
			watchIntervalMs: 1_000,
		});
	}

	for (const cores of [1, 3]) {
		it(`counts ${cores} in the line it reports while healthy`, async () => {
			const limiter = await limiterAt(cores, () => handle);

			await limiter.ensureGroup();
			const line = await limiter.statusLine();
			await limiter.dispose();

			expect(line).toContain(cores === 1 ? "1 core," : `${cores} cores,`);
			if (cores === 1) expect(line).not.toContain("1 cores");
			expect(line).not.toMatch(PARENTHETICAL_PLURAL);
		});

		it(`counts ${cores} in the line it reports after setup failed`, async () => {
			const limiter = await limiterAt(cores, () => {
				throw new Error("nope");
			});

			await limiter.ensureGroup();
			const line = await limiter.statusLine();
			await limiter.dispose();

			expect(line).toBe(
				cores === 1
					? "configured for 1 core but group setup failed"
					: `configured for ${cores} cores but group setup failed`,
			);
		});
	}
});
