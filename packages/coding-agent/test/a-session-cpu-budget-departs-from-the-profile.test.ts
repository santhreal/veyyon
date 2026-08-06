/**
 * `/cpu-limit` changes one session's CPU budget without touching the saved one.
 *
 * WHY THIS SUITE EXISTS. `session.cpuLimitCores` is a per-profile setting. It
 * is chosen once and every session that profile starts inherits it, which is
 * right for a default and wrong for the moment the default gets in the way: a
 * build that needs the whole machine, run from a profile capped at two cores,
 * had no answer except opening `/settings` and editing the value for every
 * future session too, then remembering to put it back.
 *
 * So the command has to hold a line that is easy to cross by accident. Every
 * branch that changes something writes a RUNTIME override, never the config.
 * A `set` here would look identical in the session that ran it and would be
 * discovered weeks later, in a different session, as a cap nobody chose. Each
 * case below therefore asserts BOTH halves: what the session now sees, and
 * that the saved value under it did not move.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { applyCpuLimitCommand, CPU_LIMIT_USAGE } from "@veyyon/coding-agent/slash-commands/helpers/cpu-limit";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

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

it("sets a different budget for this session and leaves the profile's number alone", async () => {
	const settings = await profileCappedAt(2);

	const result = await applyCpuLimitCommand("8", settings, null);

	expect(result.ok).toBe(true);
	expect(settings.get("session.cpuLimitCores")).toBe(8);
	expect(settings.getSource("session.cpuLimitCores")).toBe("runtime");
	expect(result.message).toContain("this session");
	expect(await savedCores()).toBe(2);
});

it("lifts the cap on remove, so the session is uncapped while the profile still is not", async () => {
	const settings = await profileCappedAt(4);

	const result = await applyCpuLimitCommand("remove", settings, null);

	expect(result.ok).toBe(true);
	expect(settings.get("session.cpuLimitCores")).toBe(0);
	// The LAYER is the assertion that bites. A reload of the config file races a
	// pending flush, so it can read the old number back while the write it is
	// meant to catch is still in flight; the source cannot.
	expect(settings.getSource("session.cpuLimitCores")).toBe("runtime");
	expect(await savedCores()).toBe(4);
	// The operator has to be able to tell "lifted here" from "there was never a
	// cap", because only one of those is theirs to undo.
	expect(result.message).toContain("profile setting is unchanged");
});

it("treats off, none and 0 as the same request as remove", async () => {
	for (const word of ["off", "none", "0"]) {
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
	await applyCpuLimitCommand("remove", settings, null);

	const result = await applyCpuLimitCommand("reset", settings, null);

	expect(result.ok).toBe(true);
	expect(settings.get("session.cpuLimitCores")).toBe(2);
	// The distinction that makes reset worth having: the value is inherited
	// again, so a later change to the profile wins instead of being shadowed by
	// a copy of what it used to say.
	expect(settings.getSource("session.cpuLimitCores")).not.toBe("runtime");
	expect(result.message).toContain("the saved profile setting");
});

it("reset also drops a kill override, so one word restores the whole profile decision", async () => {
	const settings = await profileCappedAt(2, false);
	await applyCpuLimitCommand("kill on", settings, null);
	expect(settings.get("session.cpuLimitKill")).toBe(true);

	await applyCpuLimitCommand("reset", settings, null);

	expect(settings.get("session.cpuLimitKill")).toBe(false);
	expect(settings.getSource("session.cpuLimitKill")).not.toBe("runtime");
});

it("switches the over-budget action for this session only", async () => {
	const settings = await profileCappedAt(2, false);

	const on = await applyCpuLimitCommand("kill on", settings, null);
	expect(on.ok).toBe(true);
	expect(settings.get("session.cpuLimitKill")).toBe(true);
	expect(settings.getSource("session.cpuLimitKill")).toBe("runtime");

	const off = await applyCpuLimitCommand("kill off", settings, null);
	expect(off.ok).toBe(true);
	expect(settings.get("session.cpuLimitKill")).toBe(false);

	const reloaded = await Settings.loadIsolated({ agentDir, cwd: agentDir });
	expect(reloaded.get("session.cpuLimitKill")).toBe(false);
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
