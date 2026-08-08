import type { PresetDef, StatusLinePreset } from "./types";

export const STATUS_LINE_PRESETS: Record<StatusLinePreset, PresetDef> = {
	default: {
		// Decluttered: the essentials only — model, mode, where you are, context.
		// Cost/PR/collab live in their own views, not crammed on the composer.
		//
		// Icons are blank in the default theme (see theme.ts), so segments read as
		// plain words divided by the footline's quiet `·` — the premium,
		// decluttered look.
		//
		// `profile` leads: it hides on the built-in "default" profile, so a vanilla
		// user sees nothing, but any named sandbox ("work", "rec") reads first, so you
		// always know which config, sessions, and keys are live.
		//
		// `account` is in every preset, including `minimal`, on the same terms: it is silent for a
		// provider with one stored credential, so a single-account user pays nothing for it, and it
		// names the serving account the moment there are two. Load balancing is off by default, so
		// one of those accounts is being spent and the others are not; which one that is cannot be
		// something you have to open a card to find out.
		leftSegments: ["profile", "model", "account", "mode", "path", "git", "context_pct"],
		rightSegments: ["session_name"],
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 40, stripWorkPrefix: true },
			git: { showBranch: true },
		},
	},

	minimal: {
		leftSegments: ["profile", "account", "path", "git"],
		rightSegments: ["session_name", "mode", "context_pct"],
		segmentOptions: {
			path: { abbreviate: true, maxLength: 30 },
			git: { showBranch: true },
		},
	},

	compact: {
		leftSegments: ["profile", "model", "account", "mode", "git", "pr"],
		rightSegments: ["session_name", "cost", "context_pct"],
		segmentOptions: {
			model: { showThinkingLevel: false },
			git: { showBranch: true },
		},
	},

	full: {
		leftSegments: ["pi", "hostname", "profile", "model", "account", "mode", "path", "git", "pr", "subagents"],
		rightSegments: [
			"session_name",
			"cache_hit",
			"token_in",
			"token_out",
			"token_rate",
			"cache_read",
			"cost",
			"context_pct",
			"time_spent",
			"time",
		],
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 50 },
			git: { showBranch: true },
			time: { format: "24h", showSeconds: false },
		},
	},

	nerd: {
		// Full preset with all Nerd Font icons
		leftSegments: [
			"pi",
			"hostname",
			"profile",
			"model",
			"account",
			"mode",
			"path",
			"git",
			"pr",
			"session",
			"subagents",
		],
		rightSegments: [
			"session_name",
			"token_in",
			"token_out",
			"cache_read",
			"cache_write",
			"token_rate",
			"cost",
			"context_pct",
			"context_total",
			"time_spent",
			"time",
		],
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 60 },
			git: { showBranch: true },
			time: { format: "24h", showSeconds: true },
		},
	},

	ascii: {
		// No Nerd Font dependencies
		leftSegments: ["profile", "model", "account", "mode", "path", "git", "pr"],
		rightSegments: ["session_name", "token_total", "cost", "context_pct"],
		segmentOptions: {
			model: { showThinkingLevel: true },
			path: { abbreviate: true, maxLength: 40 },
			git: { showBranch: true },
		},
	},

	custom: {
		// User-defined - these are just defaults that get overridden
		leftSegments: ["profile", "model", "account", "mode", "path", "git", "pr"],
		rightSegments: ["session_name", "token_total", "cost", "context_pct"],
		segmentOptions: {},
	},
};

export function getPreset(name: StatusLinePreset): PresetDef {
	return STATUS_LINE_PRESETS[name] ?? STATUS_LINE_PRESETS.default;
}
