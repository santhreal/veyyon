import { DEFAULT_SHARE_URL } from "@veyyon/wire";
import { DEFAULT_RELAY_URL } from "../../collab/protocol";
import { DEFAULT_STT_MODEL_KEY, STT_MODEL_OPTIONS, STT_MODEL_VALUES } from "../../stt/models";
import { STT_SUBMIT_TRIGGER_OPTIONS, STT_SUBMIT_TRIGGER_VALUES } from "../../stt/submit-trigger";

/** Interaction domain slice of SETTINGS_SCHEMA — composed in ../settings-schema.ts. */
export const INTERACTION_SETTINGS = {
	// ────────────────────────────────────────────────────────────────────────
	// Interaction
	// ────────────────────────────────────────────────────────────────────────

	// Conversation flow
	steeringMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Steering Mode",
			description: "How to process queued messages while agent is working",
		},
	},

	followUpMode: {
		type: "enum",
		values: ["all", "one-at-a-time"] as const,
		default: "one-at-a-time",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Follow-Up Mode",
			description: "How to drain follow-up messages after a turn completes",
		},
	},

	interruptMode: {
		type: "enum",
		values: ["immediate", "wait"] as const,
		default: "immediate",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Interrupt Mode",
			description: "When steering messages interrupt tool execution",
		},
	},

	"loop.mode": {
		type: "enum",
		values: ["prompt", "compact", "reset"] as const,
		default: "prompt",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Loop Mode",
			description: "What happens between /loop iterations before re-submitting the prompt",
			options: [
				{
					value: "prompt",
					label: "Prompt",
					description: "Re-submit the prompt as a follow-up message (current behavior)",
				},
				{
					value: "compact",
					label: "Compact",
					description: "Compact the session context, then re-submit the prompt",
				},
				{ value: "reset", label: "Reset", description: "Start a new session, then re-submit the prompt" },
			],
		},
	},

	// Input and startup
	doubleEscapeAction: {
		type: "enum",
		values: ["branch", "tree", "none"] as const,
		default: "tree",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Double-Escape Action",
			description: "Action when pressing Escape twice with empty editor",
		},
	},

	treeFilterMode: {
		type: "enum",
		values: ["default", "no-tools", "user-only", "labeled-only", "all"] as const,
		default: "default",
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Session Tree Filter",
			description: "Default filter mode when opening the session tree",
		},
	},

	autocompleteMaxVisible: {
		type: "number",
		default: 5,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Autocomplete Items",
			description: "Max visible items in autocomplete dropdown (3-20)",
			options: [
				{ value: "3", label: "3 items" },
				{ value: "5", label: "5 items" },
				{ value: "7", label: "7 items" },
				{ value: "10", label: "10 items" },
				{ value: "15", label: "15 items" },
				{ value: "20", label: "20 items" },
			],
		},
	},

	emojiAutocomplete: {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Emoji Autocomplete",
			description: "Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`",
		},
	},

	"paste.largeMenuThreshold": {
		type: "number",
		default: 100,
		ui: {
			tab: "interaction",
			group: "Input",
			label: "Large Paste Menu",
			description:
				"When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. 0 disables the menu (large pastes still collapse to a [Paste] marker).",
			options: [
				{ value: "0", label: "Off" },
				{ value: "100", label: "100 lines" },
				{ value: "250", label: "250 lines" },
				{ value: "500", label: "500 lines" },
				{ value: "1000", label: "1000 lines" },
			],
		},
	},

	"startup.quiet": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Quiet Startup",
			description: "Skip welcome screen and startup status messages",
		},
	},

	"startup.showSplash": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Show Startup Splash",
			description:
				"Show the full animated setup splash on normal interactive startup without rerunning setup. Quiet Startup still suppresses it.",
		},
	},

	"startup.setupWizard": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Setup Wizard",
			description: "Show newly added onboarding steps once per setup version",
		},
	},

	"startup.checkUpdate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Check for Updates",
			description: "Check for Veyyon updates on startup",
		},
	},

	"marketplace.autoUpdate": {
		type: "enum",
		values: ["off", "notify", "auto"] as const,
		default: "notify",
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Marketplace Auto-Update",
			description: "Check for plugin updates on startup",
			options: [
				{ value: "off", label: "Off", description: "Don't check for plugin updates" },
				{ value: "notify", label: "Notify", description: "Check on startup and notify when updates are available" },
				{ value: "auto", label: "Auto", description: "Check on startup and auto-install updates" },
			],
		},
	},

	collapseChangelog: {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Startup & Updates",
			label: "Collapse Changelog",
			description: "Show condensed changelog after updates",
		},
	},

	"magicKeywords.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Magic Keywords",
			description: "Enable hidden notices for standalone ultrathink, orchestrate, and workflowz keywords",
		},
	},

	"magicKeywords.ultrathink": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Ultrathink Keyword",
			description: "Let standalone ultrathink request maximum automatic thinking and append its hidden notice",
		},
	},

	"magicKeywords.orchestrate": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Orchestrate Keyword",
			description: "Let standalone orchestrate append its hidden multi-agent orchestration notice",
		},
	},

	"magicKeywords.workflow": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Magic Keywords",
			label: "Workflow Keyword",
			description: "Let standalone workflowz append its hidden eval workflow notice",
		},
	},

	// Notifications
	"completion.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Completion Notification",
			description: "Notify when the agent finishes a turn",
		},
	},

	"ask.timeout": {
		type: "number",
		default: 0,
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Ask Timeout",
			description: "Auto-select the recommended ask option after this many seconds (0 disables)",
			options: [
				{ value: "0", label: "Disabled" },
				{ value: "15", label: "15 seconds" },
				{ value: "30", label: "30 seconds" },
				{ value: "60", label: "60 seconds" },
				{ value: "120", label: "120 seconds" },
			],
		},
	},

	"ask.notify": {
		type: "enum",
		values: ["on", "off"] as const,
		default: "on",
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Ask Notification",
			description: "Notify when the ask tool is waiting for input",
		},
	},

	"recap.enabled": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Idle Recap",
			description: "Generate a brief LLM recap of where things stand after the terminal has been idle",
		},
	},

	"recap.idleSeconds": {
		type: "number",
		default: 240,
		ui: {
			tab: "interaction",
			group: "Notifications",
			label: "Idle Recap Delay",
			description: "Seconds to wait while idle before showing the recap",
			options: [
				{ value: "60", label: "1 minute" },
				{ value: "120", label: "2 minutes" },
				{ value: "240", label: "4 minutes" },
				{ value: "300", label: "5 minutes" },
				{ value: "600", label: "10 minutes" },
			],
		},
	},

	// Collab
	"collab.relayUrl": {
		type: "string",
		default: DEFAULT_RELAY_URL,
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Relay URL",
			description: "Relay used by /collab (wss://host[:port])",
		},
	},

	"collab.webUrl": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Web UI URL",
			description:
				"Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only",
		},
	},

	"collab.displayName": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Display Name",
			description: "Name shown to other collab participants (default: OS username)",
		},
	},

	"profile.displayName": {
		type: "string",
		default: "",
		ui: {
			tab: "interaction",
			group: "Profile",
			label: "Profile Name",
			description:
				'Display name for the active profile, shown in /profile list and resolvable by /profile <name>. Stored per profile; empty falls back to the profile\'s directory name ("default" for the base profile).',
		},
	},
	"session.workdir": {
		type: "string",
		default: undefined,
		ui: {
			tab: "interaction",
			group: "Profile",
			label: "Default Working Directory",
			description:
				"Per-profile default session working directory used when launching without an explicit --cwd. Precedence: an explicit --cwd wins, then this setting, then the directory you launched from. Use an absolute or ~-relative path; a relative path or a missing directory makes launch fail loudly. The agent can override the live session cwd for that session only via set_cwd / /cwd without writing this setting.",
		},
	},

	"share.serverUrl": {
		type: "string",
		default: DEFAULT_SHARE_URL,
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Share Server",
			description:
				"Share viewer/upload base used by /share (encrypted blob upload + viewer; links are <base>/<id>#<key>)",
		},
	},

	"share.store": {
		type: "enum",
		values: ["blob", "gist"] as const,
		default: "blob",
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Share Store",
			description: "Where /share uploads the encrypted session blob",
			options: [
				{
					value: "blob",
					label: "Encrypted Blob",
					description: "Upload to the share server (no GitHub account needed; avoids gist API rate limits)",
				},
				{
					value: "gist",
					label: "GitHub Gist",
					description: "Push to a secret gist (needs authenticated gh), falling back to the share server",
				},
			],
		},
	},

	"share.redactSecrets": {
		type: "boolean",
		default: true,
		ui: {
			tab: "interaction",
			group: "Collab",
			label: "Share Secret Redaction",
			description: "Run the secret obfuscator over /share snapshots before upload (uses the secrets.* config)",
		},
	},

	// Speech-to-text
	"stt.enabled": {
		type: "boolean",
		default: false,
		ui: {
			tab: "interaction",
			group: "Speech",
			label: "Speech-to-Text",
			description: "Enable speech-to-text input via microphone",
		},
	},

	"stt.language": {
		type: "string",
		default: "en",
	},

	"stt.modelName": {
		type: "enum",
		values: STT_MODEL_VALUES,
		default: DEFAULT_STT_MODEL_KEY,
		ui: {
			tab: "interaction",
			group: "Speech",
			label: "Speech Model",
			description:
				"Local on-device speech model. Parakeet TDT v3 (sherpa-onnx) is the SoTA default; Whisper base/small/large-v3-turbo tiers (transformers.js) trade size for multilingual coverage. Downloaded on first use.",
			options: STT_MODEL_OPTIONS,
		},
	},
	"stt.submitTrigger": {
		type: "enum",
		values: STT_SUBMIT_TRIGGER_VALUES,
		default: "never",
		ui: {
			tab: "interaction",
			group: "Speech",
			label: "Speech-to-Text Submit Trigger",
			description:
				"Choose when speech dictation automatically submits: Never, Release (2+ words), Release with complete sentence, or When I Say Submit.",
			options: STT_SUBMIT_TRIGGER_OPTIONS,
		},
	},
} as const;
