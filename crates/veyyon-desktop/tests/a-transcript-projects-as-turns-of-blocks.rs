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
use support::{NOW_MS, agent_blocks, entry, session};
use veyyon_desktop::{PANE_LINE_CEILING, SessionIndex, project};
use veyyon_desktop_model::{
	BlockKind, ContentBlock, EntryId, EntryMeta, HostEvent, MessageRole, QueuePartition, SessionId,
	SnapshotSection, Store, StreamingMessageState, Versioned, reduce,
};
use veyyon_desktop_surface::{Artifact, Badge, Block, ShellState, Turn};

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
			id:           "c".to_string(),
			name:         "read".to_string(),
			arguments:    serde_json::json!({ "path": "src/lib.rs" }),
			presentation: None,
		},
	]));
	tree.append(entry("t1", Some("a1"), MessageRole::ToolResult, vec![ContentBlock::ToolResult {
		tool:         "c".to_string(),
		content:      serde_json::json!("12 lines\nmore"),
		is_error:     false,
		presentation: None,
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
		matches!(&blocks[1], Block::Invoke { tool, target, result, .. }
			if tool == "read" && target == "src/lib.rs" && result.as_deref() == Some("12 lines\nmore")),
		"the result attaches to its call with disclosure content intact: {:?}",
		blocks[1]
	);
	assert!(matches!(&blocks[2], Block::Prose(p) if p == "done"));
}

#[test]
fn empty_entries_preserve_branch_links_without_creating_visible_turns() {
	for role in MessageRole::ALL {
		let mut store = Store::new();
		store.persisted.shell.active_session = Some(SessionId::from("s"));
		let tree = store.transcripts.entry(SessionId::from("s")).or_default();
		tree.append(entry("hidden", None, role, vec![]));
		let mut state = ShellState::default();
		let mut index = SessionIndex::new();
		project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
		assert!(state.transcript.is_empty(), "{role:?} has no displayable content");
		let tree = store
			.transcripts
			.get_mut(&SessionId::from("s"))
			.expect("retained tree");
		tree.append(entry("visible", Some("hidden"), MessageRole::User, vec![ContentBlock::Text {
			text: "A visible prompt".into(),
		}]));
		project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
		assert!(
			matches!(state.transcript.as_slice(), [Turn::Operator(text)] if text == "A visible prompt"),
			"{role:?}: hidden parents must not introduce empty turns"
		);
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
			| BlockKind::Unknown => None,
		};
		if let Some((label, text, boundary)) = expected_note {
			assert_eq!(blocks, &[Block::Note { label, text: text.into(), boundary }], "{kind:?}");
		}
		if kind == BlockKind::FileMention {
			assert!(matches!(&blocks[0], Block::Artifact(Artifact::File {
				path, has_content: false, lines: None, bytes: None, unavailable_reason: None, image: None
			}) if path == "README.md"));
		}
	}
}

#[test]
fn the_active_branch_is_read_from_the_leaf_and_a_streaming_reply_is_the_last_turn() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	store.sessions.insert(session("s", QueuePartition::Live));
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
	// The chip says the turn is working; the line says which tool it is in.
	assert_eq!(state.run_status, Some((Badge::Working, "bash".to_string())));
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
	assert_eq!(caption, "Shell: seq · exit 2");
	assert_eq!(lines.len(), PANE_LINE_CEILING + 1);
	assert_eq!(lines.last().map(String::as_str), Some("… 5 more lines"));
}

#[test]
fn an_agent_turn_names_the_model_the_last_entry_in_it_reported() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	let tree = store.transcripts.entry(SessionId::from("s")).or_default();
	tree.append(entry("u1", None, MessageRole::User, vec![ContentBlock::Text {
		text: "do it".to_string(),
	}]));
	let mut first = entry("a1", Some("u1"), MessageRole::Assistant, vec![ContentBlock::Text {
		text: "reading".to_string(),
	}]);
	first.meta = Some(meta_naming("claude-sonnet-4-6"));
	tree.append(first);
	let mut second = entry("a2", Some("a1"), MessageRole::Assistant, vec![ContentBlock::Text {
		text: "done".to_string(),
	}]);
	second.meta = Some(meta_naming("claude-opus-4-1"));
	tree.append(second);

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	let Some(Turn::Agent { model, .. }) = state.transcript.get(1) else {
		panic!("the reply is one agent turn: {:?}", state.transcript);
	};
	assert_eq!(
		model.as_deref(),
		Some("claude-opus-4-1"),
		"the turn's footer names {model:?}: an agent turn is several entries, and the model that \
		 produced its latest output is the one the operator is reading"
	);
}

#[test]
fn a_turn_the_host_reported_no_model_for_names_none() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	let tree = store.transcripts.entry(SessionId::from("s")).or_default();
	tree.append(entry("a1", None, MessageRole::Assistant, vec![ContentBlock::Text {
		text: "reading".to_string(),
	}]));

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	let Some(Turn::Agent { model, .. }) = state.transcript.first() else {
		panic!("the reply is one agent turn: {:?}", state.transcript);
	};
	assert_eq!(
		model.as_deref(),
		None,
		"the turn names {model:?} from an entry that reported no model, so its footer would name a \
		 model the host never stated"
	);
}

/// Entry metadata naming a model and nothing else.
fn meta_naming(model: &str) -> EntryMeta {
	EntryMeta {
		provider:    Some("anthropic".to_string()),
		model:       Some(model.to_string()),
		stop_reason: None,
		error:       None,
		usage:       None,
	}
}
