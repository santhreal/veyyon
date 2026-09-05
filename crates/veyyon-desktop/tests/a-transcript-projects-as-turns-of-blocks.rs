//! WHY: the transcript the host streams reached no pixel until `project`
//! turned entries into turns and blocks. This suite is the transcript half of
//! that projection: what an operator said, what came back, which branch is
//! read, and how a pane is held to its ceiling.
//!
//! CLASS CLOSED: a `BlockKind` the projection drops. The kinds are swept from
//! the enum at run time, so a variant added to the model fails here until the
//! projection states what it draws. Also a streaming reply that lands anywhere
//! but last, a reopened transcript that shows twice, and an abandoned branch
//! that is drawn.
//!
//! NOT CAUGHT: whether the shell draws a block correctly; that is the surface
//! crate's pixel suites. Session, changes, drawer and footer projection are
//! in `the-host-model-projects-onto-the-shell.rs`; intents are in
//! `an-intent-maps-to-the-actions-the-host-answers.rs`.

mod support;

use std::{collections::HashMap, fmt::Write as _};

use strum::IntoEnumIterator as _;
use support::{NOW_MS, agent_blocks, entry};
use veyyon_desktop::{PANE_LINE_CEILING, SessionIndex, project};
use veyyon_desktop_model::{
	BlockKind, ContentBlock, EntryId, HostEvent, MessageRole, SessionId, SnapshotSection, Store,
	StreamingMessageState, Versioned, reduce,
};
use veyyon_desktop_surface::{Badge, Block, ShellState, Turn};

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
			id:        "call-1".to_string(),
			name:      "read".to_string(),
			arguments: serde_json::json!({ "path": "src/lib.rs" }),
		},
		BlockKind::ToolResult => ContentBlock::ToolResult {
			tool:     "read".to_string(),
			content:  serde_json::json!("12 lines"),
			is_error: false,
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
	}
}

#[test]
fn a_turn_is_what_the_operator_said_and_everything_that_came_back() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	let tree = store.transcripts.entry(SessionId::from("s")).or_default();
	tree.append(entry("u1", None, MessageRole::User, vec![ContentBlock::Text {
		text: "do it".to_string(),
	}]));
	tree.append(entry("a1", Some("u1"), MessageRole::Assistant, vec![
		ContentBlock::Text { text: "reading".to_string() },
		ContentBlock::ToolCall {
			id:        "c".to_string(),
			name:      "read".to_string(),
			arguments: serde_json::json!({ "path": "src/lib.rs" }),
		},
	]));
	tree.append(entry("t1", Some("a1"), MessageRole::ToolResult, vec![ContentBlock::ToolResult {
		tool:     "read".to_string(),
		content:  serde_json::json!("12 lines\nmore"),
		is_error: false,
	}]));
	tree.append(entry("a2", Some("t1"), MessageRole::Assistant, vec![ContentBlock::Text {
		text: "done".to_string(),
	}]));

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	assert_eq!(state.transcript.len(), 2, "one operator turn, one agent turn");
	assert!(matches!(&state.transcript[0], Turn::Operator(text) if text == "do it"));
	let blocks = agent_blocks(&state.transcript[1]);
	assert!(matches!(&blocks[0], Block::Prose(p) if p == "reading"));
	assert!(
		matches!(&blocks[1], Block::Invoke { tool, target, result }
			if tool == "read" && target == "src/lib.rs" && result.as_deref() == Some("12 lines")),
		"the result attaches to its call, first line only: {:?}",
		blocks[1]
	);
	assert!(matches!(&blocks[2], Block::Prose(p) if p == "done"));
}

#[test]
fn every_block_kind_draws_something() {
	for kind in BlockKind::iter() {
		let mut store = Store::new();
		store.persisted.shell.active_session = Some(SessionId::from("s"));
		let tree = store.transcripts.entry(SessionId::from("s")).or_default();
		tree.append(entry("a", None, MessageRole::Assistant, vec![block_of(kind)]));
		let mut state = ShellState::default();
		project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
		let blocks = agent_blocks(&state.transcript[0]);
		assert_eq!(blocks.len(), 1, "{kind:?} draws one block, got {blocks:?}");
	}
}

#[test]
fn the_active_branch_is_read_from_the_leaf_and_a_streaming_reply_is_the_last_turn() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	let tree = store.transcripts.entry(SessionId::from("s")).or_default();
	tree.append(entry("u1", None, MessageRole::User, vec![ContentBlock::Text { text: "a".into() }]));
	tree.append(entry("a-old", Some("u1"), MessageRole::Assistant, vec![ContentBlock::Text {
		text: "abandoned branch".into(),
	}]));
	tree.append(entry("a-new", Some("u1"), MessageRole::Assistant, vec![ContentBlock::Text {
		text: "kept branch".into(),
	}]));
	store
		.streaming
		.insert(SessionId::from("s"), StreamingMessageState {
			entry:        EntryId::from("stream-1"),
			tool:         Some("bash".to_string()),
			accumulating: entry("stream-1", None, MessageRole::Assistant, vec![ContentBlock::Text {
				text: "partial".into(),
			}]),
			revision:     2,
		});

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	let prose: Vec<String> = state
		.transcript
		.iter()
		.skip(1)
		.flat_map(agent_blocks)
		.filter_map(|block| match block {
			Block::Prose(text) => Some(text.clone()),
			_ => None,
		})
		.collect();
	assert_eq!(prose, ["kept branch", "partial"], "the leaf's branch, then the stream");
	assert_eq!(state.run_status, Some((Badge::Working, "Working · bash".to_string())));
}

#[test]
fn a_transcript_snapshot_replaces_what_an_earlier_one_loaded() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	let snapshot = |ids: &[&str]| {
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    ids
				.iter()
				.map(|id| {
					entry(id, None, MessageRole::User, vec![ContentBlock::Text { text: (*id).into() }])
				})
				.collect(),
		}))
	};
	reduce(&mut store, snapshot(&["a", "b", "c"]));
	reduce(&mut store, snapshot(&["d"]));

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	assert_eq!(state.transcript.len(), 1, "a reopen shows the reopened transcript once");
	assert!(matches!(&state.transcript[0], Turn::Operator(text) if text == "d"));
}

#[test]
fn a_pane_is_held_to_its_ceiling_with_the_remainder_counted() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	let mut output = String::new();
	for n in 0..PANE_LINE_CEILING + 5 {
		writeln!(output, "line {n}").unwrap();
	}
	let tree = store.transcripts.entry(SessionId::from("s")).or_default();
	tree.append(entry("a", None, MessageRole::BashExecution, vec![ContentBlock::Execution {
		language: "bash".into(),
		command: Some("seq".into()),
		output,
		exit_code: Some(2),
	}]));
	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	let Block::Pane { caption, lines } = &agent_blocks(&state.transcript[0])[0] else {
		panic!("an execution is a pane");
	};
	assert_eq!(caption, "seq · exit 2");
	assert_eq!(lines.len(), PANE_LINE_CEILING + 1);
	assert_eq!(lines.last().map(String::as_str), Some("… 5 more lines"));
}
