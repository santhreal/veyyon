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
 * TWO SCOPES, PAIRED PER RESOURCE. Each group holds the machine limit, then the
 * session limit, then any policy for that resource, because the question being
 * answered is "how much CPU" and the answer has two halves.
 *
 * `session.*` bounds the session TREE: this session, every subagent under it at
 * any depth, and every process any of them spawned. They share ONE budget group
 * (see session/cpu-limit.ts), so a limit cannot be multiplied by delegating.
 * It is per-profile, in the profile's `agent/config.yml`.
 *
 * `machine.*` bounds every veyyon on the machine at once: every session, every
 * profile, and every concurrently running veyyon. It is `scope: "global"`, so it
 * is stored in `~/.veyyon/config.yml` through GLOBAL_SETTING_BINDINGS and read
 * by all of them; held per profile it would be a limit each copy applied to
 * itself, and the machine would get the sum. Session groups are nested inside
 * the machine group, so the outer cap holds whatever the inner ones say.
 *
 * Both default to 0, which is no limit.
 */
export const RESOURCES_SETTINGS = {
	// ────────────────────────────────────────────────────────────────────────
	// CPU
	// ────────────────────────────────────────────────────────────────────────

	"machine.cpuLimitCores": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			scope: "global",
			group: "CPU",
			label: "Machine CPU Limit",
			description:
				"Maximum CPU every veyyon process on this machine may use TOGETHER, in cores (0 = no limit). Stored in ~/.veyyon/config.yml rather than in a profile, so it covers every profile and every veyyon running at once, which is what makes it a machine limit: held per profile, two profiles would read their own copy and the machine would get the sum. Each session's budget group is created INSIDE this one, so on Linux the kernel caps the whole subtree and no combination of sessions can exceed it. A per-session limit larger than this one is bounded by it and does not raise it. Where the kernel cannot hold it, a notice says so once at startup rather than reporting a cap that does not exist.",
			keywords: ["cpu", "global", "machine", "limit", "quota", "cgroup", "cores", "budget", "all"],
			options: [
				{ value: "0", label: "Off", description: "Default" },
				{ value: "1", label: "1 core" },
				{ value: "2", label: "2 cores" },
				{ value: "4", label: "4 cores" },
				{ value: "8", label: "8 cores" },
				{ value: "16", label: "16 cores" },
				{ value: "32", label: "32 cores" },
			],
		},
	},

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

	"machine.memoryLimitGb": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			scope: "global",
			group: "Memory",
			label: "Machine Memory Limit",
			description:
				"Maximum resident memory every veyyon process on this machine may hold together, in gigabytes (0 = no limit). Stored in ~/.veyyon/config.yml, so it spans profiles and concurrent veyyon instances. Every session budget group sits inside this one, so on Linux this is cgroup v2 memory.max on the parent and the kernel reclaims, then OOM-kills, inside the subtree once the total is reached — whichever process the kernel picks, with no warning and no chance to finish. Set it where an OOM kill is preferable to the machine swapping. Where no memory controller is delegated the cap cannot be held, and a notice says so once at startup.",
			keywords: ["memory", "ram", "global", "machine", "limit", "oom", "cgroup", "gb", "all"],
			options: [
				{ value: "0", label: "Off", description: "Default" },
				{ value: "2", label: "2 GB" },
				{ value: "4", label: "4 GB" },
				{ value: "8", label: "8 GB" },
				{ value: "16", label: "16 GB" },
				{ value: "32", label: "32 GB" },
				{ value: "64", label: "64 GB" },
				{ value: "128", label: "128 GB" },
			],
		},
	},

	"session.memoryLimitGb": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			group: "Memory",
			label: "Session Memory Limit",
			description:
				"Maximum resident memory the session tree may hold at once, in gigabytes (0 = off). The session tree is this session, every subagent under it at any depth, and every process any of them spawned: they share one budget group, so delegating work cannot multiply the allowance. This is a kernel cap, not a polite refusal: on Linux it is cgroup v2 memory.max on the session budget group, so a group at the limit is reclaimed first and then a process INSIDE it is OOM-killed by the kernel, whichever process the kernel picks, with no warning and no chance to finish. Set it where an OOM kill is preferable to the machine swapping, and leave it off if a killed command would cost more than the memory does. A host without a memory controller reports the limit as unenforceable once at startup rather than pretending to hold it.",
			keywords: ["memory", "ram", "limit", "oom", "cgroup", "budget", "gb"],
			// Optionless numbers are dropped by the UI adapter; the ladder is what
			// makes the row exist. See session.cpuLimitCores.
			options: [
				{ value: "0", label: "Off", description: "Default" },
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

	"machine.writeBudgetGb": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			scope: "global",
			group: "Disk",
			label: "Machine Write Budget",
			description:
				"Cumulative gigabytes every veyyon process on this machine may WRITE before further writes are refused (0 = no limit). Stored in ~/.veyyon/config.yml, so it spans profiles and concurrent veyyon instances. Unlike CPU and memory this is a total that accumulates, not a level: it counts bytes written since the machine budget was last reset, across every session, and refuses new commands and harness writes once the total is reached. A write budget is the one limit no kernel enforces on its own — cgroup io accounting MEASURES bytes and caps rate, not a lifetime total — so this is a refusal, and work already writing runs to completion.",
			keywords: ["disk", "write", "global", "machine", "budget", "gb", "io", "quota", "all"],
			options: [
				{ value: "0", label: "Off", description: "Default" },
				{ value: "5", label: "5 GB" },
				{ value: "10", label: "10 GB" },
				{ value: "25", label: "25 GB" },
				{ value: "50", label: "50 GB" },
				{ value: "100", label: "100 GB" },
				{ value: "250", label: "250 GB" },
			],
		},
	},

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

	"machine.maxProcesses": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			scope: "global",
			group: "Processes",
			label: "Machine Max Processes",
			description:
				"Hard cap on how many processes every veyyon on this machine may have alive at once (0 = no limit). Stored in ~/.veyyon/config.yml, so it spans profiles and concurrent veyyon instances. Every session budget group sits inside this one, so on Linux this is cgroup v2 pids.max on the parent and the kernel refuses the fork itself once the subtree is full, whichever session asked. Where pids is not delegated the cap is a refusal at the spawn path instead, and a notice says so once at startup.",
			keywords: ["processes", "pids", "fork", "global", "machine", "limit", "cap", "bomb", "all"],
			options: [
				{ value: "0", label: "Off", description: "Default" },
				{ value: "64", label: "64 processes" },
				{ value: "128", label: "128 processes" },
				{ value: "256", label: "256 processes" },
				{ value: "512", label: "512 processes" },
				{ value: "1024", label: "1024 processes" },
				{ value: "2048", label: "2048 processes" },
			],
		},
	},

	"session.maxProcesses": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			group: "Processes",
			label: "Session Max Processes",
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
