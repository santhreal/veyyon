//! WHY: a `BlockKind` the projection drops reaches no pixel, and the drop is
//! silent: the turn still renders, one block short. The kinds are swept from
//! the enum at run time, so a variant added to the model fails here until the
//! projection states what it draws.
//!
//! CLASS CLOSED: every member of `BlockKind`, each constructed and projected,
//! with the note kinds pinned to the words they state and the two kinds that
//! carry their own payload -- a file mention and a recorded report -- pinned to
//! what a reader copies out of them.
//!
//! NOT CAUGHT: how the shell draws any of them, which is the surface crate's
//! pixel suites, and the rest of the projection, which is
//! `a-transcript-projects-as-turns-of-blocks.rs`.

mod support;

use std::collections::HashMap;

use strum::IntoEnumIterator as _;
use support::{NOW_MS, agent_blocks, entry};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{BlockKind, ContentBlock, MessageRole, SessionId, Store};
use veyyon_desktop_surface::{Artifact, Block, ShellState};

fn block_of(kind: BlockKind) -> ContentBlock {
	match kind {
		BlockKind::Text => ContentBlock::Text { text: "prose".to_string() },
		BlockKind::Image => ContentBlock::Image {
			media_type: "image/png".to_string(),
			data:       vec![0],
			alt:        None,
		},
		BlockKind::Video => {
			ContentBlock::Video { media_type: "video/mp4".to_string(), bytes: 12_400_000 }
		},
		BlockKind::Thinking => ContentBlock::Thinking { text: "why".to_string() },
		BlockKind::RedactedThinking => ContentBlock::RedactedThinking { marker: "r".to_string() },
		BlockKind::ToolCall => ContentBlock::ToolCall {
			id:           "call-1".to_string(),
			name:         "read".to_string(),
			arguments:    serde_json::json!({ "path": "src/lib.rs" }),
			presentation: None,
		},
		BlockKind::ToolResult => ContentBlock::ToolResult {
			tool:         "read".to_string(),
			content:      serde_json::json!("12 lines"),
			is_error:     false,
			presentation: None,
		},
		BlockKind::Execution => ContentBlock::Execution {
			language:  "bash".to_string(),
			command:   Some("ls".to_string()),
			output:    "a\nb".to_string(),
			exit_code: Some(0),
		},
		BlockKind::FileMention => ContentBlock::FileMention {
			path:               "README.md".to_string(),
			has_content:        false,
			lines:              None,
			bytes:              None,
			unavailable_reason: None,
			image:              None,
		},
		BlockKind::Diff => ContentBlock::Diff { raw: "-a\n+b".to_string() },
		BlockKind::ModelChange => {
			ContentBlock::ModelChange { provider: "p".to_string(), model: "m".to_string() }
		},
		BlockKind::ThinkingChange => ContentBlock::ThinkingChange { level: "high".to_string() },
		BlockKind::ModeChange => ContentBlock::ModeChange { mode: "plan".to_string() },
		BlockKind::Lifecycle => ContentBlock::Lifecycle { phase: "start".to_string(), reason: None },
		BlockKind::Summary => {
			ContentBlock::Summary { kind: "compaction".to_string(), text: "sum".to_string() }
		},
		BlockKind::Fallback => {
			ContentBlock::Fallback { producer: "ext".to_string(), value: serde_json::Value::Null }
		},
		BlockKind::Unknown => {
			ContentBlock::Unknown { tag: "x".to_string(), value: serde_json::Value::Null }
		},
		BlockKind::Custom => ContentBlock::Custom {
			variant: "irc".to_string(),
			view:    std::sync::Arc::new(veyyon_desktop_model::tool_view::ToolView::StatusRow(
				veyyon_desktop_model::tool_view::StatusRowView::new("IRC ← Scout"),
			)),
		},
	}
}

#[test]
fn every_block_kind_preserves_its_display_register() {
	for kind in BlockKind::iter() {
		let mut store = Store::new();
		store.persisted.shell.active_session = Some(SessionId::from("s"));
		let tree = store.transcripts.entry(SessionId::from("s")).or_default();
		tree.append(entry("a", None, MessageRole::Assistant, vec![block_of(kind)]));
		let mut state = ShellState::default();
		project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
		let blocks = agent_blocks(&state.transcript[0]);
		assert_eq!(blocks.len(), 1, "{kind:?} draws one block, got {blocks:?}");
		let expected_note = match kind {
			BlockKind::ModelChange => Some(("Model", "p/m", false)),
			BlockKind::ThinkingChange => Some(("Thinking", "high", false)),
			BlockKind::ModeChange => Some(("Mode", "plan", false)),
			BlockKind::Lifecycle => Some(("Lifecycle", "start", false)),
			BlockKind::Summary => Some(("Summary", "compaction: sum", true)),
			BlockKind::Text
			| BlockKind::Image
			| BlockKind::FileMention
			| BlockKind::Video
			| BlockKind::Thinking
			| BlockKind::RedactedThinking
			| BlockKind::ToolCall
			| BlockKind::ToolResult
			| BlockKind::Execution
			| BlockKind::Diff
			| BlockKind::Fallback
			| BlockKind::Unknown
			| BlockKind::Custom => None,
		};
		if let Some((label, text, boundary)) = expected_note {
			assert_eq!(blocks, &[Block::Note { label, text: text.into(), boundary }], "{kind:?}");
		}
		if kind == BlockKind::FileMention {
			assert!(matches!(&blocks[0], Block::Artifact(Artifact::File {
				path, has_content: false, lines: None, bytes: None, unavailable_reason: None, image: None
			}) if path == "README.md"));
		}
		if kind == BlockKind::Custom {
			// A recorded report keeps the words its view states, so the rows a
			// reader copies and searches are the rows the card draws.
			assert!(
				matches!(&blocks[0], Block::Report { variant, lines, .. }
					if variant == "irc" && lines == &["IRC ← Scout".to_string()]),
				"a report keeps its kind and its words, got {blocks:?}"
			);
		}
	}
}
