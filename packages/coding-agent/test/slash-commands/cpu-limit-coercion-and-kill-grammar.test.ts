/**
 * `/cpu-limit` parses the argument with `Number(arg)` after a lowercased trim.
 * a-session-cpu-budget-departs-from-the-profile.test.ts already pins remove /
 * reset / off / none / 0 / kill on vs the saved profile. Remaining:
 *
 *   - Number("0x10") is 16; Number("2e1") is 20; Number("2.5") is 2.5
 *   - Number("+4") is 4; the documented grammar is a bare decimal integer
 *   - `kill on extra` falls through the kill regex to Number() → NaN → usage
 *   - inherit / default are RESET_WORDS (drop override), not REMOVE_WORDS
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { applyCpuLimitCommand, CPU_LIMIT_USAGE } from "@veyyon/coding-agent/slash-commands/helpers/cpu-limit";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

let agentDir = "";

async function profileCappedAt(cores: number, kill = false): Promise<Settings> {
	const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
	settings.set("session.cpuLimitCores", cores);
	settings.set("session.cpuLimitKill", kill);
	await settings.flush();
	return settings;
}

async function savedCores(): Promise<number> {
	const reloaded = await Settings.loadIsolated({ agentDir, cwd: agentDir });
	return reloaded.get("session.cpuLimitCores");
}

beforeEach(() => {
	agentDir = path.join(os.tmpdir(), `pi-cpu-coerce-${Snowflake.next()}`);
	fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	if (agentDir && fs.existsSync(agentDir)) removeSyncWithRetries(agentDir);
});

describe("a core count is a decimal integer, not Number() grammar", () => {
	it("refuses 0x10 instead of reading it as sixteen cores", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("0x10", settings, null);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
		expect(await savedCores()).toBe(2);
	});

	it("refuses 2e1 instead of reading it as twenty cores", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("2e1", settings, null);
		expect(result.ok).toBe(false);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
	});

	it("refuses a fractional core count instead of storing 2.5", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("2.5", settings, null);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
	});

	it("refuses +4 — the documented grammar is a bare integer, not a signed Number", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("+4", settings, null);
		expect(result.ok).toBe(false);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
	});
});

describe("kill grammar is the whole argument, not a prefix", () => {
	it("refuses 'kill on extra' instead of applying kill and dropping the tail", async () => {
		const settings = await profileCappedAt(2, false);
		const result = await applyCpuLimitCommand("kill on extra", settings, null);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
		expect(settings.get("session.cpuLimitKill")).toBe(false);
	});
});

describe("inherit drops the override; it does not lift the cap the way off does", () => {
	it("inherit restores the profile number rather than writing 0", async () => {
		const settings = await profileCappedAt(2);
		await applyCpuLimitCommand("8", settings, null);
		expect(settings.get("session.cpuLimitCores")).toBe(8);
		const inherit = await applyCpuLimitCommand("inherit", settings, null);
		expect(inherit.ok).toBe(true);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
		expect(await savedCores()).toBe(2);
	});
});
