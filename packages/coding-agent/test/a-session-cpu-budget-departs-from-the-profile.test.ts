/**
 * `/cpu-limit` reports limits and lifts one session's CPU cap, and configures
 * nothing.
 *
 * WHY THIS SUITE EXISTS. A resource limit has two scopes — `machine.*` across
 * every veyyon on the machine, `session.*` across one session tree — and both
 * are chosen in `/settings` under Resources. The command used to be a third
 * way to set the session one. That made the panel and the command disagree
 * silently: the panel showed the stored number, the command had overridden it,
 * and the session ran under a cap neither surface named.
 *
 * So the line this suite holds runs both ways. A configuring invocation must
 * be REFUSED, with usage that says where the value does live — a version that
 * quietly accepts a number again puts the second owner back. And the two
 * things that are not configuration must keep working: `status`, which reports
 * what enforcement is really doing rather than what is stored, and `lift`,
 * which writes a RUNTIME override so a build that needs the whole machine is
 * not blocked by a sensible default. Each lift case asserts BOTH halves: what
 * this session now sees, and that the saved value under it did not move.
 *
 * WHAT IT DOES NOT CATCH. It drives the command against an isolated profile,
 * not a live limiter, so it proves what is stored and reported, never that the
 * kernel applied anything. The cgroup tier is covered by cpu-limit-real-cgroup
 * and the machine-budget suites.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { machineBudgetPlacement, resetSessionCpuLimitsForTests } from "@veyyon/coding-agent/session/cpu-limit";
import { applyCpuLimitCommand, CPU_LIMIT_USAGE } from "@veyyon/coding-agent/slash-commands/helpers/cpu-limit";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import * as YAML from "yaml";
import { makeCgroupRoot, makeDelegatedParent, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";

let agentDir = "";

/** A profile that already caps sessions, which is the state the command exists to depart from. */
async function profileCappedAt(cores: number, kill = false): Promise<Settings> {
	const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
	settings.set("session.cpuLimitCores", cores);
	settings.set("session.cpuLimitKill", kill);
	await settings.flush();
	return settings;
}

/** What a fresh load of the same profile sees, which is what a later session would inherit. */
async function savedCores(): Promise<number> {
	const reloaded = await Settings.loadIsolated({ agentDir, cwd: agentDir });
	return reloaded.get("session.cpuLimitCores");
}

beforeEach(() => {
	agentDir = path.join(os.tmpdir(), `pi-cpu-cmd-${Snowflake.next()}`);
	fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	if (agentDir && fs.existsSync(agentDir)) removeSyncWithRetries(agentDir);
});

it("reports the budget and names the profile as its source before anything is overridden", async () => {
	const settings = await profileCappedAt(2);

	const result = await applyCpuLimitCommand("", settings, null);

	expect(result.ok).toBe(true);
	expect(result.message).toContain("2 core(s)");
	expect(result.message).toContain("the saved profile setting");
	expect(result.message).toContain("refused");
});

it("refuses to set a budget, because a limit has one home and it is /settings", async () => {
	const settings = await profileCappedAt(2);

	// A number used to be accepted here and written as a runtime override. That
	// made two places a limit could come from, and the panel showed only one of
	// them: the value on screen was right, the value in force was not, and
	// nothing said which was which. Refusing is the whole point of the change,
	// so a version that quietly starts accepting a number again must go red.
	for (const word of ["8", "2", "0.5", "16"]) {
		// "0" is deliberately absent: it is a LIFT word, asserted below.
		const result = await applyCpuLimitCommand(word, settings, null);

		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
		expect(settings.getSource("session.cpuLimitCores")).not.toBe("runtime");
	}
	expect(settings.get("session.cpuLimitCores")).toBe(2);
	expect(await savedCores()).toBe(2);
});

it("names /settings and both scopes in the usage, so a refusal says where the value does live", async () => {
	const settings = await profileCappedAt(2);

	const result = await applyCpuLimitCommand("8", settings, null);

	// A refusal that only says "bad usage" moves the problem rather than
	// solving it: the person still has a limit to change and now no idea where.
	expect(result.message).toContain("/settings");
	expect(result.message).toContain("machine");
	expect(result.message).toContain("session");
});

it("lifts the cap on lift, so the session is uncapped while the profile still is not", async () => {
	const settings = await profileCappedAt(4);

	const result = await applyCpuLimitCommand("lift", settings, null);

	expect(result.ok).toBe(true);
	expect(settings.get("session.cpuLimitCores")).toBe(0);
	// The LAYER is the assertion that bites. A reload of the config file races a
	// pending flush, so it can read the old number back while the write it is
	// meant to catch is still in flight; the source cannot.
	expect(settings.getSource("session.cpuLimitCores")).toBe("runtime");
	expect(await savedCores()).toBe(4);
	// The operator has to be able to tell "lifted here" from "there was never a
	// cap", because only one of those is theirs to undo.
	expect(result.message).toContain("No setting was changed");
});

it("treats remove, off, none and 0 as the same request as lift", async () => {
	for (const word of ["remove", "off", "none", "0"]) {
		const settings = await profileCappedAt(4);
		const result = await applyCpuLimitCommand(word, settings, null);
		expect(result.ok).toBe(true);
		expect(settings.get("session.cpuLimitCores")).toBe(0);
		expect(settings.getSource("session.cpuLimitCores")).toBe("runtime");
		expect(await savedCores()).toBe(4);
	}
});

it("drops the override on reset rather than writing the saved number back", async () => {
	const settings = await profileCappedAt(2);
	await applyCpuLimitCommand("lift", settings, null);

	const result = await applyCpuLimitCommand("reset", settings, null);

	expect(result.ok).toBe(true);
	expect(settings.get("session.cpuLimitCores")).toBe(2);
	// The distinction that makes reset worth having: the value is inherited
	// again, so a later change to the profile wins instead of being shadowed by
	// a copy of what it used to say.
	expect(settings.getSource("session.cpuLimitCores")).not.toBe("runtime");
	expect(result.message).toContain("the saved profile setting");
});

it("reset drops a kill override too, so one word restores the whole configured decision", async () => {
	const settings = await profileCappedAt(2, false);
	// Written directly, not through the command: `/cpu-limit kill on` is gone,
	// but an override can still reach this key from elsewhere (a --config flag,
	// a future caller), and reset must clear BOTH keys or a lifted session keeps
	// half its override forever.
	settings.override("session.cpuLimitKill", true);
	expect(settings.get("session.cpuLimitKill")).toBe(true);

	await applyCpuLimitCommand("reset", settings, null);

	expect(settings.get("session.cpuLimitKill")).toBe(false);
	expect(settings.getSource("session.cpuLimitKill")).not.toBe("runtime");
});

it("refuses to switch the over-budget action, which is a setting and not a session departure", async () => {
	const settings = await profileCappedAt(2, false);

	// `kill on|off` was configuration wearing a command's clothes: it changed
	// what happens to every over-budget command for the rest of the session,
	// and the panel never showed that it had. It belongs to the Resources tab.
	for (const word of ["kill on", "kill off", "kill true", "kill false"]) {
		const result = await applyCpuLimitCommand(word, settings, null);

		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
	}
	expect(settings.get("session.cpuLimitKill")).toBe(false);
	expect(settings.getSource("session.cpuLimitKill")).not.toBe("runtime");
});

it("refuses a word it cannot read instead of reading it as zero", async () => {
	const settings = await profileCappedAt(4);

	for (const word of ["two", "8cores", "-1", "kill maybe"]) {
		const result = await applyCpuLimitCommand(word, settings, null);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
	}
	// The failure has to be inert. `Number("two")` is NaN and `Number("")` is 0,
	// so the parse that rejects these is one character away from silently
	// lifting the cap the operator was trying to change.
	expect(settings.get("session.cpuLimitCores")).toBe(4);
	expect(settings.getSource("session.cpuLimitCores")).not.toBe("runtime");
});

/**
 * The machine half of `status`.
 *
 * A machine limit needs a cgroup parent that delegates two levels, which a
 * container's cgroup root does not, so "configured" and "held" are different
 * facts. Printing the configured cores alone is the defect the nestable probe
 * closed at the limiter, reappearing at the only surface an operator reads to
 * find out whether the cap is real.
 */
describe("the machine tier in a status report", () => {
	let configRoot = "";
	let previousConfigDir: string | undefined;

	beforeEach(() => {
		configRoot = path.join(os.tmpdir(), `pi-cpu-cmd-cfg-${Snowflake.next()}`);
		fs.mkdirSync(configRoot, { recursive: true });
		fs.writeFileSync(
			path.join(configRoot, "config.yml"),
			YAML.stringify({ machine: { cpuLimitCores: 3, memoryLimitGb: 0, writeBudgetGb: 0, maxProcesses: 0 } }),
		);
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

	it("says the limit is not applied yet when nothing has needed the budget group", async () => {
		const settings = await profileCappedAt(2);

		const result = await applyCpuLimitCommand("status", settings, null);

		expect(result.message).toContain("3 core(s)");
		expect(result.message).toContain("Not applied yet");
	});

	it("says the kernel is holding it once a placement resolved with every configured cap held", async () => {
		const settings = await profileCappedAt(2);
		const root = await makeCgroupRoot();
		const parentDir = await makeDelegatedParent(root);
		// The kernel writes `cgroup.controllers` into a directory on mkdir; a
		// tmpdir stand-in has to place it, or the machine group looks like one
		// that can delegate nothing downward.
		const machineDir = path.join(parentDir, "veyyon.machine");
		fs.mkdirSync(machineDir, { recursive: true });
		fs.writeFileSync(path.join(machineDir, "cgroup.controllers"), "cpu io memory pids");
		fs.writeFileSync(path.join(machineDir, "cgroup.subtree_control"), "");
		await machineBudgetPlacement(makeFakeHost(root).env, parentDir);

		const result = await applyCpuLimitCommand("status", settings, null);

		expect(result.message).toContain("The kernel is holding it");
		// The session asks for 2 and the machine cap is 3, so nothing is bounded
		// and the report must not claim it is.
		expect(result.message).not.toContain("bounded by it");
	});

	it("says a session cap above the machine cap is bounded by it, rather than printing two numbers", async () => {
		// Session groups are created INSIDE the machine group. "4 core(s)" beside
		// "3 core(s)" with nothing relating them reads as the larger one winning.
		const settings = await profileCappedAt(4);
		const root = await makeCgroupRoot();
		const parentDir = await makeDelegatedParent(root);
		const machineDir = path.join(parentDir, "veyyon.machine");
		fs.mkdirSync(machineDir, { recursive: true });
		fs.writeFileSync(path.join(machineDir, "cgroup.controllers"), "cpu io memory pids");
		fs.writeFileSync(path.join(machineDir, "cgroup.subtree_control"), "");
		await machineBudgetPlacement(makeFakeHost(root).env, parentDir);

		const result = await applyCpuLimitCommand("status", settings, null);

		expect(result.message).toContain("This session's 4 core(s) are bounded by it");
	});

	it("reports the cap as unheld rather than printing the configured cores alone", async () => {
		const settings = await profileCappedAt(2);
		const root = await makeCgroupRoot();
		// A parent that delegates nothing: the container case, where the cores
		// are configured and the kernel applies none of them.
		const parentDir = await makeDelegatedParent(root, { controllers: "" });
		await machineBudgetPlacement(makeFakeHost(root).env, parentDir);

		const result = await applyCpuLimitCommand("status", settings, null);

		expect(result.message).toContain("3 core(s)");
		expect(result.message).toContain("not held");
		expect(result.message).toContain("Per-session limits still apply");
		expect(result.message).not.toContain("The kernel is holding it");
	});

	it("names the machine limit in a lift message as text, not as a pending promise", async () => {
		// The lift path builds its own sentence rather than reusing the report,
		// so it is the one place a machine description can be interpolated
		// unawaited and reach the operator as "[object Promise]".
		const settings = await profileCappedAt(2);

		const result = await applyCpuLimitCommand("lift", settings, null);

		expect(result.ok).toBe(true);
		expect(result.message).not.toContain("[object Promise]");
		expect(result.message).toContain("3 core(s)");
		expect(result.message).toContain("That one still applies");
	});
});
