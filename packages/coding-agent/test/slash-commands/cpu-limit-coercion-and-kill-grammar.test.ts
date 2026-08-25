/**
 * `/cpu-limit` parses the argument with `Number(arg)` after a lowercased trim.
 *
 * WHY THIS SUITE EXISTS. The session-vs-profile suite pins that `remove` /
 * `reset` / `kill on` write runtime overrides and leave the saved profile
 * alone. It does not pin WHAT COUNTS AS A CORE COUNT. The parser is
 * `Number(arg)` plus `Number.isFinite` and `cores < 0`:
 *
 *   - `Number("0x10")` is 16. An operator who typed a hex dump fragment, or
 *     a model that echoed `0x2`, silently recaps the session at 16 cores.
 *   - `Number("2e1")` is 20. Scientific notation is not a core count.
 *   - `Number("2.5")` is 2.5. The limiter talks in integer cores; a
 *     fractional override is not a value the cgroup quota can honour.
 *   - `kill on extra` does not match `^kill\s+(on|off|true|false)$` and
 *     falls through to `Number(...)` → NaN → usage. Pin that it does NOT
 *     apply the kill and ignore the tail.
 *   - `inherit` / `default` are RESET_WORDS. `off` is a REMOVE_WORD. The
 *     two must not swap: `off` lifts the cap (override 0); `inherit` drops
 *     the override so the profile number returns.
 *
 * The desired contract: only a decimal integer core count, the documented
 * words, and `kill on|off|true|false` with nothing after them. Failures
 * stay red until `Number(arg)` is replaced with an integer parser.
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
		expect(result.message).toBe(CPU_LIMIT_USAGE);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
	});

	it("refuses 2E1 (uppercase exponent) the same way", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("2E1", settings, null);
		expect(result.ok).toBe(false);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
	});

	it("refuses a fractional core count instead of storing 2.5", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("2.5", settings, null);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
		expect(await savedCores()).toBe(2);
	});

	it("refuses +4 — the documented grammar is a bare integer, not a signed Number", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("+4", settings, null);
		expect(result.ok).toBe(false);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
	});

	it("refuses 8,0 (locale grouping)", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("8,0", settings, null);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
	});

	it("refuses 1_000 underscore grouping", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("1_000", settings, null);
		expect(result.ok).toBe(false);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
	});

	it("refuses Infinity / -Infinity / NaN words", async () => {
		const settings = await profileCappedAt(2);
		for (const word of ["Infinity", "-Infinity", "NaN", "infinity"]) {
			const result = await applyCpuLimitCommand(word, settings, null);
			expect(result.ok).toBe(false);
			expect(result.message).toBe(CPU_LIMIT_USAGE);
		}
		expect(settings.get("session.cpuLimitCores")).toBe(2);
	});

	it("refuses a leading minus even for -0", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("-0", settings, null);
		expect(result.ok).toBe(false);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
		expect(await savedCores()).toBe(2);
	});

	it("accepts a bare decimal integer and still does not write the profile", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("8", settings, null);
		expect(result.ok).toBe(true);
		expect(settings.get("session.cpuLimitCores")).toBe(8);
		expect(await savedCores()).toBe(2);
	});

	it("trims surrounding whitespace of a decimal integer", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("  4  ", settings, null);
		expect(result.ok).toBe(true);
		expect(settings.get("session.cpuLimitCores")).toBe(4);
		expect(await savedCores()).toBe(2);
	});
});

describe("kill grammar is the whole argument, not a prefix", () => {
	it("refuses 'kill on extra' instead of applying kill and dropping the tail", async () => {
		const settings = await profileCappedAt(2, false);
		const result = await applyCpuLimitCommand("kill on extra", settings, null);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
		expect(settings.get("session.cpuLimitKill")).toBe(false);
		expect(await savedCores()).toBe(2);
	});

	it("refuses a bare 'kill' with no on/off", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("kill", settings, null);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
	});

	it("accepts 'Kill ON' because the argument is lowercased before the regex", async () => {
		const settings = await profileCappedAt(2, false);
		const result = await applyCpuLimitCommand("Kill ON", settings, null);
		expect(result.ok).toBe(true);
		expect(settings.get("session.cpuLimitKill")).toBe(true);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
		expect(await savedCores()).toBe(2);
	});

	it("accepts a tab between kill and on (the regex is \\s+)", async () => {
		const settings = await profileCappedAt(2, false);
		const result = await applyCpuLimitCommand("kill\ton", settings, null);
		expect(result.ok).toBe(true);
		expect(settings.get("session.cpuLimitKill")).toBe(true);
	});

	it("accepts kill true / kill false as aliases of on / off", async () => {
		const settings = await profileCappedAt(2, false);
		const on = await applyCpuLimitCommand("kill true", settings, null);
		expect(on.ok).toBe(true);
		expect(settings.get("session.cpuLimitKill")).toBe(true);
		const off = await applyCpuLimitCommand("kill false", settings, null);
		expect(off.ok).toBe(true);
		expect(settings.get("session.cpuLimitKill")).toBe(false);
		expect(await savedCores()).toBe(2);
	});

	it("does not treat the word 'true' by itself as kill-on or as a core count", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("true", settings, null);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
		expect(settings.get("session.cpuLimitKill")).toBe(false);
	});
});

describe("RESET_WORDS and REMOVE_WORDS must not swap", () => {
	it("inherit / default drop the override like reset, they do not lift the cap to 0", async () => {
		const settings = await profileCappedAt(2);
		await applyCpuLimitCommand("8", settings, null);
		expect(settings.get("session.cpuLimitCores")).toBe(8);

		const inherit = await applyCpuLimitCommand("inherit", settings, null);
		expect(inherit.ok).toBe(true);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
		expect(await savedCores()).toBe(2);

		await applyCpuLimitCommand("8", settings, null);
		const def = await applyCpuLimitCommand("default", settings, null);
		expect(def.ok).toBe(true);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
		expect(await savedCores()).toBe(2);
	});

	it("off / none / 0 lift the cap (override 0) and leave the profile at 2", async () => {
		for (const word of ["off", "none", "0"]) {
			const settings = await profileCappedAt(2);
			const result = await applyCpuLimitCommand(word, settings, null);
			expect(result.ok).toBe(true);
			expect(settings.get("session.cpuLimitCores")).toBe(0);
			expect(await savedCores()).toBe(2);
		}
	});

	it("'status extra' is not status — extra tokens are usage, not ignored", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("status extra", settings, null);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
	});

	it("'2 cores' is not a core count", async () => {
		const settings = await profileCappedAt(2);
		const result = await applyCpuLimitCommand("2 cores", settings, null);
		expect(result.ok).toBe(false);
		expect(result.message).toBe(CPU_LIMIT_USAGE);
		expect(settings.get("session.cpuLimitCores")).toBe(2);
	});
});
