/**
 * Resources domain slice of SETTINGS_SCHEMA, composed in ../settings-schema.ts.
 *
 * Every limit on what a session may CONSUME lives here, on one visible tab, because
 * a budget an operator cannot find is a budget that is never set. The CPU rows were
 * buried under Shell -> "CPU Limit" next to interpreter paths, which is where you
 * look for how a command runs, not for how much of the machine it may take.
 *
 * The keys did not change when the rows moved, so an existing `config.yml` that sets
 * `session.cpuLimitCores` keeps working and there is no migration.
 *
 * SCOPE OF EVERY LIMIT ON THIS TAB: the session TREE, not one agent. That is this
 * session, every subagent under it at any depth, and every process any of them
 * spawned. They share ONE budget group (see session/cpu-limit.ts), so a limit cannot
 * be multiplied by delegating.
 */
export const RESOURCES_SETTINGS = {
	// ────────────────────────────────────────────────────────────────────────
	// CPU
	// ────────────────────────────────────────────────────────────────────────

	"session.cpuLimitCores": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			group: "CPU",
			label: "Session CPU Limit",
			description:
				"Maximum CPU a session's spawned processes may use, in cores (0 = off). This is the per-profile default: every session that profile starts inherits it, and one session can depart from it with /cpu-limit <cores> or lift it entirely with /cpu-limit remove, neither of which writes this setting. Every process the session starts (bash commands, MCP servers, custom tools, launch tasks, workers) joins a per-session budget group: a cgroup v2 quota on Linux, a Job Object hard cap on Windows, both kernel-enforced, so the group throttles as a whole. While the group runs saturated, new commands are refused with an error naming the budget. On macOS there is no kernel quota, so enforcement is policy-only (refuse new commands, renice, optional kill) and a startup warning says so. The harness's own compute (agent turns, in-process workers) is never capped.",
			keywords: ["cpu", "limit", "quota", "cgroup", "throttle", "cores", "budget"],
			// A numeric setting with no option list is dropped by the UI adapter
			// (pathToSettingDef treats optionless numbers as schema-only), so the
			// ladder is what makes the row exist. See subagent.idleTtlMs.
			options: [
				{ value: "0", label: "Off", description: "Default" },
				{ value: "1", label: "1 core" },
				{ value: "2", label: "2 cores" },
				{ value: "4", label: "4 cores" },
				{ value: "8", label: "8 cores" },
				{ value: "16", label: "16 cores" },
			],
		},
	},

	"session.cpuLimitKill": {
		type: "boolean",
		default: false,
		ui: {
			tab: "resources",
			group: "CPU",
			label: "Kill Over-Budget Commands",
			description:
				"What happens when spawned commands stay at the CPU limit for seconds at a time. Off (default): new commands are refused until usage drops, running ones keep running (throttled where the OS offers a quota, reniced on macOS). On: the over-budget group is also sent SIGTERM, and the kill is reported as a budget action, not a crash. /cpu-limit kill on|off changes it for one session without writing this setting.",
			keywords: ["cpu", "limit", "kill", "sigterm", "budget"],
			condition: "cpuLimitEnabled",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Memory
	// ────────────────────────────────────────────────────────────────────────

	"session.memoryLimitGb": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			group: "Memory",
			label: "Session Memory Limit",
			description:
				"Maximum resident memory the session tree may hold at once, in gigabytes (0 = unlimited). The session tree is this session, every subagent under it at any depth, and every process any of them spawned: they share one budget group, so delegating work cannot multiply the allowance. This is a kernel cap, not a polite refusal: on Linux it is cgroup v2 memory.max on the session budget group, so a group at the limit is reclaimed first and then a process INSIDE it is OOM-killed by the kernel, whichever process the kernel picks, with no warning and no chance to finish. Set it where an OOM kill is preferable to the machine swapping, and leave it off if a killed command would cost more than the memory does. A host without a memory controller reports the limit as unenforceable once at startup rather than pretending to hold it.",
			keywords: ["memory", "ram", "limit", "oom", "cgroup", "budget", "gb"],
			// Optionless numbers are dropped by the UI adapter; the ladder is what
			// makes the row exist. See session.cpuLimitCores.
			options: [
				{ value: "0", label: "Unlimited", description: "Default" },
				{ value: "2", label: "2 GB" },
				{ value: "4", label: "4 GB" },
				{ value: "8", label: "8 GB" },
				{ value: "16", label: "16 GB" },
				{ value: "32", label: "32 GB" },
				{ value: "64", label: "64 GB" },
			],
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Disk
	// ────────────────────────────────────────────────────────────────────────

	"session.writeBudgetGb": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			group: "Disk",
			label: "Session Write Budget",
			description:
				"Cumulative gigabytes the session tree may WRITE to disk before further writes are refused (0 = off). The session tree is this session, every subagent under it at any depth, and every process any of them spawned: they share one budget group, so delegating work cannot multiply the allowance. Writes are metered by the same group that meters CPU (cgroup v2 io accounting on Linux, Job Object I/O accounting on Windows). Once the total is reached, a new command is refused with an error naming the budget and how much it has written; already running commands keep running unless Kill Over-Budget Writers is on. A host where write accounting cannot be read reports the limit as unenforceable once at startup rather than pretending to hold it.",
			keywords: ["disk", "write", "budget", "gb", "io", "quota", "limit"],
			// Optionless numbers are dropped by the UI adapter; the ladder is what
			// makes the row exist. See session.cpuLimitCores.
			options: [
				{ value: "0", label: "Off", description: "Default" },
				{ value: "1", label: "1 GB" },
				{ value: "5", label: "5 GB" },
				{ value: "10", label: "10 GB" },
				{ value: "25", label: "25 GB" },
				{ value: "50", label: "50 GB" },
				{ value: "100", label: "100 GB" },
			],
		},
	},

	"session.writeBudgetKill": {
		type: "boolean",
		default: false,
		ui: {
			tab: "resources",
			group: "Disk",
			label: "Kill Over-Budget Writers",
			description:
				"What happens when the session tree passes its write budget. Off (default): new commands are refused, and whatever is already writing runs to completion. On: the over-budget group is also sent SIGTERM, and the kill is reported as a budget action rather than a crash, so a command that vanished mid-write is explained instead of looking like a failure. Hidden while the write budget is 0, because a kill policy for a budget that does not exist is a knob with nothing behind it.",
			keywords: ["disk", "write", "budget", "kill", "sigterm"],
			condition: "writeBudgetEnabled",
		},
	},

	// ────────────────────────────────────────────────────────────────────────
	// Processes
	// ────────────────────────────────────────────────────────────────────────

	"session.maxProcesses": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			group: "Processes",
			label: "Max Processes",
			description:
				"Hard cap on how many processes may be alive at once across the session tree (0 = off). The session tree is this session, every subagent under it at any depth, and every process any of them spawned, all in one budget group, so the cap is not multiplied by delegating. Enforced by the kernel where it can be: cgroup v2 pids.max on Linux and a Job Object process limit on Windows both refuse the fork itself, so a runaway loop stops instead of filling the process table. Elsewhere the cap is policy-only, refusing a new spawn with an error naming the limit and the current count, and a startup notice says the kernel is not holding it.",
			keywords: ["processes", "pids", "fork", "limit", "cap", "bomb"],
			// Optionless numbers are dropped by the UI adapter; the ladder is what
			// makes the row exist. See session.cpuLimitCores.
			options: [
				{ value: "0", label: "Off", description: "Default" },
				{ value: "32", label: "32 processes" },
				{ value: "64", label: "64 processes" },
				{ value: "128", label: "128 processes" },
				{ value: "256", label: "256 processes" },
				{ value: "512", label: "512 processes" },
				{ value: "1024", label: "1024 processes" },
			],
		},
	},
} as const;
