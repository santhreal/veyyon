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
 * ONE SCOPE PER TAB. Everything here is `session.*`: it bounds the session TREE,
 * meaning this session, every agent under it at any depth, and every process
 * any of them spawned. They share ONE budget group (see session/cpu-limit.ts),
 * so a limit cannot be multiplied by delegating. It is per-profile, in the
 * profile's `agent/config.yml`.
 *
 * The `machine.*` limits bound every veyyon on the machine at once. They are
 * declared in ./global.ts and shown on the Global tab under "Machine Limits".
 * They were interleaved here, one machine row above one session row inside each
 * resource group, on the theory that "how much CPU" is one question with two
 * halves. It reads as eight rows of near-identical prose where four of them
 * silently write a different file, and the row a person came for is whichever
 * one they did not read. The scopes are now separated by tab, which is the
 * boundary that actually differs: this tab writes the profile, that one writes
 * ~/.veyyon/config.yml. The Resources tab opens with a row naming where the
 * machine limits are (settings-selector.ts, MACHINE_LIMITS_POINTER_ROW_ID), and
 * settings search spans tabs, so "machine cpu" still finds the row from here.
 *
 * Session groups are nested inside the machine group, so the outer cap holds
 * whatever the inner ones say. Both scopes default to 0, which is no limit.
 */
export const RESOURCES_SETTINGS = {
	"session.cpuLimitCores": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			group: "CPU",
			label: "Session CPU Limit",
			description:
				"Maximum CPU processes spawned by this session and its agents may use, in cores. Off: no limit. Stored in the active profile.",
			keywords: ["cpu", "limit", "quota", "cgroup", "throttle", "cores", "budget"],
			// A numeric setting with no option list is dropped by the UI adapter
			// (pathToSettingDef treats optionless numbers as schema-only), so the
			// ladder is what makes the row exist. See agent.idleTtlMs.
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
				"Controls whether processes running over the session CPU limit are terminated. Off: running processes continue and new commands are refused while over budget. On: processes running over budget receive SIGTERM.",
			keywords: ["cpu", "limit", "kill", "sigterm", "budget"],
			condition: "cpuLimitEnabled",
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
				"Maximum resident memory processes spawned by this session and its agents may use, in gigabytes. Off: no limit. Stored in the active profile.",
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

	"session.writeBudgetGb": {
		type: "number",
		default: 0,
		ui: {
			tab: "resources",
			group: "Disk",
			label: "Session Write Budget",
			description:
				"Cumulative disk writes permitted for this session and its agents, in gigabytes. Off: no limit. Once reached, subsequent commands and tool writes are refused.",
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
				"Controls whether processes are terminated when the session write budget is exceeded. Off: running processes continue and new commands are refused. On: running processes receive SIGTERM.",
			keywords: ["disk", "write", "budget", "kill", "sigterm"],
			condition: "writeBudgetEnabled",
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
				"Maximum concurrent processes that this session and its agents may run. Off: no limit. Stored in the active profile.",
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
