//! Deterministic synthesised fixture constructors for scene testing.
//!
//! Fixture data is generated purely in memory with fixed constants or pure
//! functions of a seed. No session captures, disk reads, clocks, or random
//! number generators are used.

use veyyon_desktop_model::{
	BadgeKind, BlockKind, ContentBlock, EntryId, EntryMeta, MessageRole, QueuePartition, Session,
	SessionBadge, SessionId, SessionStatus, SessionSummary, TranscriptEntry, UsageTotals,
};

/// Text fixtures providing typical and extreme strings for layout and rendering
/// tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixtureText;

impl FixtureText {
	pub const BRANCH_EXTREME_90: &'static str =
		"feat/gui-surface-scene-catalogue-deterministic-fixtures-and-runtime-enum-validation-90char";
	/// Typical length branch name fixture.
	pub const BRANCH_TYPICAL: &'static str = "feat/gui-scenes";
	/// CJK text fixture.
	pub const CJK: &'static str = "界面场景目录与运行时枚举验证";
	/// Emoji zero-width joiner cluster fixture (single grapheme, multiple code
	/// points).
	pub const EMOJI_ZWJ_CLUSTER: &'static str = "👩‍💻";
	/// Extreme long file path fixture.
	pub const FILE_PATH_EXTREME: &'static str =
		"crates/veyyon-desktop-scene/src/metrics/\
		 gap_adjacency_filters_intervening_boxes_and_deduplicates.rs";
	/// Typical file path fixture.
	pub const FILE_PATH_TYPICAL: &'static str = "crates/veyyon-desktop-scene/src/lib.rs";
	/// String containing combining character whose naive byte truncation splits
	/// a grapheme cluster.
	pub const GRAPHEME_CLUSTER_SPLIT: &'static str = "cafe\u{0301}";
	/// Typical message text fixture.
	pub const MESSAGE_TYPICAL: &'static str =
		"Verify deterministic layout bounds across every surface state.";
	/// Single character project name fixture.
	pub const PROJECT_EXTREME_SINGLE: &'static str = "v";
	/// Typical project name fixture.
	pub const PROJECT_TYPICAL: &'static str = "veyyon";
	/// RTL (Arabic) text fixture.
	pub const RTL: &'static str = "كتالوج المشاهد والتحقق من التعداد";
	/// Typical session title fixture.
	pub const TITLE_TYPICAL: &'static str = "Implement scene catalogue registry";
}

/// Host reachability classification for protocol variant fixtures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Reachability {
	/// Variant has an active producer in the host bridge.
	Reachable,
	/// Variant has no producer in the host bridge but is defined in the protocol
	/// schema.
	Unreachable,
}

impl Reachability {
	/// Returns true if the variant is reachable from host producers.
	#[must_use]
	pub const fn is_reachable(self) -> bool {
		matches!(self, Self::Reachable)
	}
}

/// Returns the reachability status of a message role based on host bridge
/// producers.
#[must_use]
pub const fn role_reachability(role: MessageRole) -> Reachability {
	match role {
		MessageRole::User
		| MessageRole::Assistant
		| MessageRole::ToolResult
		| MessageRole::Developer
		| MessageRole::Custom
		| MessageRole::CompactionSummary
		| MessageRole::BranchSummary
		| MessageRole::Lifecycle => Reachability::Reachable,
		MessageRole::BashExecution
		| MessageRole::PythonExecution
		| MessageRole::FileMention
		| MessageRole::Unknown => Reachability::Unreachable,
	}
}

/// Returns the reachability status of a content block kind based on host bridge
/// producers.
#[must_use]
pub const fn block_reachability(kind: BlockKind) -> Reachability {
	match kind {
		BlockKind::Text
		| BlockKind::Thinking
		| BlockKind::Image
		| BlockKind::ToolCall
		| BlockKind::ToolResult
		| BlockKind::Summary
		| BlockKind::Lifecycle
		| BlockKind::Fallback
		| BlockKind::Unknown => Reachability::Reachable,
		BlockKind::RedactedThinking
		| BlockKind::Execution
		| BlockKind::FileMention
		| BlockKind::Diff
		| BlockKind::ModelChange
		| BlockKind::ThinkingChange => Reachability::Unreachable,
	}
}

/// Constructs a deterministic usage totals fixture from a seed.
#[must_use]
pub const fn usage_totals_fixture(seed: u64) -> UsageTotals {
	UsageTotals {
		input_tokens:         1000 + seed * 10,
		output_tokens:        250 + seed * 5,
		cache_read_tokens:    500 + seed * 2,
		cache_write_tokens:   100 + seed,
		orchestration_tokens: 50 + seed,
		premium_requests:     (seed % 3) as u32,
		cost_microusd:        Some(15000 + seed * 100),
	}
}

/// Constructs a deterministic entry metadata fixture from a seed.
#[must_use]
pub fn entry_meta_fixture(seed: u64) -> EntryMeta {
	EntryMeta {
		provider:    Some("anthropic".to_string()),
		model:       Some("claude-3-7-sonnet".to_string()),
		stop_reason: Some("end_turn".to_string()),
		error:       None,
		usage:       Some(usage_totals_fixture(seed)),
	}
}

/// Constructs a deterministic content block fixture for any block kind.
#[must_use]
pub fn content_block_fixture(seed: u64, kind: BlockKind) -> ContentBlock {
	match kind {
		BlockKind::Text => {
			ContentBlock::Text { text: format!("{} [seed: {seed}]", FixtureText::MESSAGE_TYPICAL) }
		},
		BlockKind::Image => ContentBlock::Image {
			media_type: "image/png".to_string(),
			data:       vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
			alt:        Some("Deterministic visual fixture".to_string()),
		},
		BlockKind::Thinking => ContentBlock::Thinking {
			text: format!("Evaluating constraint satisfaction for scene fixture {seed}."),
		},
		BlockKind::RedactedThinking => {
			ContentBlock::RedactedThinking { marker: "[redacted thinking fixture]".to_string() }
		},
		BlockKind::ToolCall => ContentBlock::ToolCall {
			id:        format!("call_seed_{seed}"),
			name:      "read_file".to_string(),
			arguments: serde_json::json!({ "path": FixtureText::FILE_PATH_TYPICAL }),
		},
		BlockKind::ToolResult => ContentBlock::ToolResult {
			tool:     "read_file".to_string(),
			content:  serde_json::json!({ "status": "ok", "lines": 42 + seed }),
			is_error: false,
		},
		BlockKind::Execution => ContentBlock::Execution {
			language:  "bash".to_string(),
			command:   Some("cargo test".to_string()),
			output:    format!("test result: ok. {seed} passed."),
			exit_code: Some(0),
		},
		BlockKind::FileMention => ContentBlock::FileMention {
			path:               FixtureText::FILE_PATH_TYPICAL.to_string(),
			has_content:        true,
			lines:              Some(100 + seed as u32),
			bytes:              Some(2048 + seed * 16),
			unavailable_reason: None,
			image:              None,
		},
		BlockKind::Diff => ContentBlock::Diff {
			raw: format!(
				"--- a/{path}\n+++ b/{path}\n@@ -1,2 +1,2 @@\n-old\n+new\n",
				path = FixtureText::FILE_PATH_TYPICAL
			),
		},
		BlockKind::ModelChange => ContentBlock::ModelChange {
			provider: "anthropic".to_string(),
			model:    "claude-3-7-sonnet".to_string(),
		},
		BlockKind::ThinkingChange => ContentBlock::ThinkingChange { level: "high".to_string() },
		BlockKind::Summary => ContentBlock::Summary {
			kind: "compaction".to_string(),
			text: format!("Compacted turns up to revision {seed}."),
		},
		BlockKind::Lifecycle => ContentBlock::Lifecycle {
			phase:  "started".to_string(),
			reason: Some("session initialized".to_string()),
		},
		BlockKind::Fallback => ContentBlock::Fallback {
			producer: "extension".to_string(),
			value:    serde_json::json!({ "seed": seed, "type": "synthetic_payload" }),
		},
		BlockKind::Unknown => ContentBlock::Unknown {
			tag:   "unrecognized_block".to_string(),
			value: serde_json::json!({ "raw": seed }),
		},
	}
}

/// Constructs a deterministic session badge fixture from a badge kind.
#[must_use]
pub const fn session_badge_fixture(kind: BadgeKind) -> SessionBadge {
	match kind {
		BadgeKind::Approval => SessionBadge::Approval,
		BadgeKind::Input => SessionBadge::Input,
		BadgeKind::Plan => SessionBadge::Plan,
		BadgeKind::Failed => SessionBadge::Failed,
		BadgeKind::Due => SessionBadge::Due,
		BadgeKind::Done => SessionBadge::Done,
		BadgeKind::Working => SessionBadge::Working { started_at_ms: 1_700_000_000_000 },
		BadgeKind::Watching => SessionBadge::Watching,
	}
}

/// Constructs a deterministic session fixture.
#[must_use]
pub fn session_fixture(
	seed: u64,
	partition: QueuePartition,
	badge: Option<SessionBadge>,
) -> Session {
	Session {
		id: SessionId::from(format!("session_{seed:04}")),
		title: format!("{} {seed}", FixtureText::TITLE_TYPICAL),
		project_name: FixtureText::PROJECT_TYPICAL.to_string(),
		branch: FixtureText::BRANCH_TYPICAL.to_string(),
		partition,
		badge,
		created_at_ms: 1_700_000_000_000 + seed * 1000,
		last_recall_at_ms: 1_700_000_000_000 + seed * 1000,
		defer_until_ms: None,
		parked_at_ms: None,
		pin_key: None,
	}
}

/// Constructs a deterministic session summary fixture.
#[must_use]
pub fn session_summary_fixture(seed: u64) -> SessionSummary {
	SessionSummary {
		id:                  SessionId::from(format!("session_{seed:04}")),
		workspace:           "/workspace/project".to_string(),
		path:                format!("/workspace/project/.veyyon/sessions/session_{seed:04}.json"),
		cwd:                 "/workspace/project".to_string(),
		title:               Some(format!("{} {seed}", FixtureText::TITLE_TYPICAL)),
		parent_path:         None,
		created_at_ms:       1_700_000_000_000 + seed * 1000,
		modified_at_ms:      1_700_000_010_000 + seed * 1000,
		message_count:       8 + (seed % 10) as u32,
		size_bytes:          4096 + seed * 256,
		first_message:       Some(FixtureText::MESSAGE_TYPICAL.to_string()),
		searchable_messages: Some(FixtureText::MESSAGE_TYPICAL.to_string()),
		status:              SessionStatus::Complete,
	}
}

/// Constructs a deterministic transcript entry fixture for any message role.
#[must_use]
pub fn transcript_entry_fixture(seed: u64, role: MessageRole) -> TranscriptEntry {
	let primary_kind = match role {
		MessageRole::User | MessageRole::Developer | MessageRole::Custom => BlockKind::Text,
		MessageRole::Assistant => BlockKind::Text,
		MessageRole::ToolResult => BlockKind::ToolResult,
		MessageRole::BashExecution | MessageRole::PythonExecution => BlockKind::Execution,
		MessageRole::BranchSummary | MessageRole::CompactionSummary => BlockKind::Summary,
		MessageRole::FileMention => BlockKind::FileMention,
		MessageRole::Lifecycle => BlockKind::Lifecycle,
		MessageRole::Unknown => BlockKind::Unknown,
	};

	let content = vec![content_block_fixture(seed, primary_kind)];

	TranscriptEntry {
		id: EntryId::from(format!("entry_{seed:04}")),
		parent: if seed > 0 {
			Some(EntryId::from(format!("entry_{:04}", seed - 1)))
		} else {
			None
		},
		revision: seed + 1,
		timestamp_ms: 1_700_000_000_000 + seed * 1000,
		role,
		content,
		meta: Some(entry_meta_fixture(seed)),
		raw_discriminator: format!("{role:?}"),
		raw: serde_json::json!({ "seed": seed, "role": format!("{role:?}") }),
	}
}
