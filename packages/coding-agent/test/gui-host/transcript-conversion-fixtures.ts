import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { ContentBlock, MessageRole } from "../../src/gui-host/wire";

export interface FixtureCase {
	entry: SessionEntry;
	expectedRole: MessageRole;
	expectedContent: ContentBlock[];
}

export const FIXTURE_TIMESTAMP = "2026-03-01T12:00:00.000Z";
export const FIXTURE_TIMESTAMP_MS = new Date(FIXTURE_TIMESTAMP).getTime();

export const EXHAUSTIVE_FIXTURES = {
	message: {
		entry: {
			type: "message",
			id: "entry-msg-1",
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
			message: { role: "user", content: "Run verification workflow", timestamp: FIXTURE_TIMESTAMP_MS },
		},
		expectedRole: "User",
		expectedContent: [{ Text: { text: "Run verification workflow" } }],
	},
	model_change: {
		entry: {
			type: "model_change",
			id: "entry-model-1",
			parentId: "entry-msg-1",
			timestamp: FIXTURE_TIMESTAMP,
			model: "anthropic/claude-3-7-sonnet",
			role: "default",
		},
		expectedRole: "Custom",
		expectedContent: [{ ModelChange: { provider: "anthropic", model: "claude-3-7-sonnet" } }],
	},
	thinking_level_change: {
		entry: {
			type: "thinking_level_change",
			id: "entry-think-1",
			parentId: "entry-model-1",
			timestamp: FIXTURE_TIMESTAMP,
			thinkingLevel: "high",
		},
		expectedRole: "Custom",
		expectedContent: [{ ThinkingChange: { level: "high" } }],
	},
	service_tier_change: {
		entry: {
			type: "service_tier_change",
			id: "entry-tier-1",
			parentId: "entry-think-1",
			timestamp: FIXTURE_TIMESTAMP,
			serviceTier: { openai: "priority", anthropic: "flex" },
		},
		expectedRole: "Custom",
		expectedContent: [{ Text: { text: "service tier: openai:priority, anthropic:flex" } }],
	},
	custom_message: {
		entry: {
			type: "custom_message",
			id: "entry-cmsg-1",
			parentId: "entry-tier-1",
			timestamp: FIXTURE_TIMESTAMP,
			customType: "annotation",
			content: "Step 1: Check baseline",
			display: true,
		},
		expectedRole: "Custom",
		expectedContent: [{ Text: { text: "Step 1: Check baseline" } }],
	},
	compaction: {
		entry: {
			type: "compaction",
			id: "entry-comp-1",
			parentId: "entry-cmsg-1",
			timestamp: FIXTURE_TIMESTAMP,
			summary: "Compacted earlier history",
			firstKeptEntryId: "entry-msg-1",
			tokensBefore: 42000,
		},
		expectedRole: "CompactionSummary",
		expectedContent: [{ Summary: { kind: "compaction", text: "Compacted earlier history" } }],
	},
	branch_summary: {
		entry: {
			type: "branch_summary",
			id: "entry-branch-1",
			parentId: "entry-comp-1",
			timestamp: FIXTURE_TIMESTAMP,
			fromId: "entry-msg-1",
			summary: "Alternative explored branch",
		},
		expectedRole: "BranchSummary",
		expectedContent: [{ Summary: { kind: "branch", text: "Alternative explored branch" } }],
	},
	session_lifecycle: {
		entry: {
			type: "session_lifecycle",
			id: "entry-life-1",
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
			state: "running",
			reason: "created",
		},
		expectedRole: "Lifecycle",
		expectedContent: [{ Lifecycle: { phase: "running", reason: "created" } }],
	},
	mode_change: {
		entry: {
			type: "mode_change",
			id: "entry-mode-1",
			parentId: "entry-branch-1",
			timestamp: FIXTURE_TIMESTAMP,
			mode: "plan",
		},
		expectedRole: "Custom",
		expectedContent: [{ Text: { text: "mode: plan" } }],
	},
	title_change: {
		entry: {
			type: "title_change",
			id: "entry-title-1",
			parentId: "entry-mode-1",
			timestamp: FIXTURE_TIMESTAMP,
			title: "Refactor Session",
			source: "user",
		},
		expectedRole: "Custom",
		expectedContent: [],
	},
	ttsr_injection: {
		entry: {
			type: "ttsr_injection",
			id: "entry-ttsr-1",
			parentId: "entry-title-1",
			timestamp: FIXTURE_TIMESTAMP,
			injectedRules: ["ruleA", "ruleB"],
		},
		expectedRole: "Custom",
		expectedContent: [{ Text: { text: "injected rules: ruleA, ruleB" } }],
	},
	mcp_tool_selection: {
		entry: {
			type: "mcp_tool_selection",
			id: "entry-mcp-1",
			parentId: "entry-ttsr-1",
			timestamp: FIXTURE_TIMESTAMP,
			selectedToolNames: ["server.tool1"],
		},
		expectedRole: "Custom",
		expectedContent: [{ Text: { text: "mcp tools: server.tool1" } }],
	},
	subagent_spawn: {
		entry: {
			type: "subagent_spawn",
			id: "entry-spawn-1",
			parentId: "entry-mcp-1",
			timestamp: FIXTURE_TIMESTAMP,
			agentId: "sub-100",
			agentName: "reviewer",
			task: "Audit diff",
			sessionFile: "/tmp/sub-100.jsonl",
			isolation: "none",
			status: "completed",
			exitCode: 0,
			durationMs: 1200,
		},
		expectedRole: "Custom",
		expectedContent: [{ Text: { text: "subagent reviewer: Audit diff (completed)" } }],
	},
	label: {
		entry: {
			type: "label",
			id: "entry-label-1",
			parentId: "entry-spawn-1",
			timestamp: FIXTURE_TIMESTAMP,
			targetId: "entry-msg-1",
			label: "milestone-1",
		},
		expectedRole: "Custom",
		expectedContent: [{ Text: { text: "label: milestone-1" } }],
	},
	session_init: {
		entry: {
			type: "session_init",
			id: "entry-init-1",
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
			systemPrompt: "System instruction",
			task: "Initial task",
			tools: ["read", "edit"],
		},
		expectedRole: "Custom",
		expectedContent: [],
	},
	settings_snapshot: {
		entry: {
			type: "settings_snapshot",
			id: "entry-settings-1",
			parentId: null,
			timestamp: FIXTURE_TIMESTAMP,
			kind: "full",
			values: { "model.default": "gpt-4o" },
		},
		expectedRole: "Custom",
		expectedContent: [],
	},
	session_checkpoint: {
		entry: {
			type: "session_checkpoint",
			id: "entry-checkpoint-1",
			parentId: "entry-settings-1",
			timestamp: FIXTURE_TIMESTAMP,
			prefixSequence: 10,
		},
		expectedRole: "Custom",
		expectedContent: [],
	},
	custom: {
		entry: {
			type: "custom",
			id: "entry-custom-1",
			parentId: "entry-label-1",
			timestamp: FIXTURE_TIMESTAMP,
			customType: "ext-state",
			data: { flag: true },
		},
		expectedRole: "Custom",
		expectedContent: [],
	},
} satisfies Record<SessionEntry["type"], FixtureCase>;
