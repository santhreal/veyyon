//! WHY: the window drew a fixture. Nothing turned what the host reported into
//! what the surfaces draw, so a session the host listed, a turn it streamed
//! and a decision it asked for reached no pixel. `project` and `action_for`
//! are that turn, in both directions.
//!
//! CLASS CLOSED: a member of the protocol model the projection drops or
//! misplaces. The partitions, badges and block kinds are swept from their
//! enums at run time, so a variant added to the model fails here until the
//! projection states what it draws. The intent side is covered for every
//! `Intent` variant, so an intent that reaches no action is a decision made
//! here rather than a silence.
//!
//! NOT CAUGHT: whether the shell draws the projected state correctly; that is
//! the surface crate's pixel suites. Whether the host sends what the model
//! expects; that is the live handshake suite.

use strum::IntoEnumIterator as _;
use veyyon_desktop::{PANE_LINE_CEILING, SessionIndex, action_for, project};
use veyyon_desktop_model::{
	ApprovalInteraction, BadgeKind, BlockKind, ContentBlock, EntryId, HostAction, HostEvent,
	InteractionId, MessageRole, PendingDecisions, PlanInteraction, QuestionInteraction,
	QueuePartition, Session, SessionBadge, SessionId, SnapshotSection, Store, StreamingMessageState,
	TranscriptEntry, Versioned, reduce,
};
use veyyon_desktop_surface::{Badge, Block, Card, Intent, Section, ShellState, Turn};

const NOW_MS: u64 = 10_000_000;

fn session(id: &str, partition: QueuePartition, badge: Option<SessionBadge>) -> Session {
	Session {
		id: SessionId::from(id),
		title: format!("title {id}"),
		project_name: "repo".to_string(),
		branch: String::new(),
		partition,
		badge,
		created_at_ms: NOW_MS - 120_000,
		last_recall_at_ms: NOW_MS - 60_000,
		defer_until_ms: None,
		parked_at_ms: None,
		pin_key: None,
	}
}

fn entry(
	id: &str,
	parent: Option<&str>,
	role: MessageRole,
	content: Vec<ContentBlock>,
) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: parent.map(EntryId::from),
		revision: 1,
		timestamp_ms: NOW_MS,
		role,
		content,
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

fn badge_of(kind: BadgeKind) -> SessionBadge {
	match kind {
		BadgeKind::Approval => SessionBadge::Approval,
		BadgeKind::Input => SessionBadge::Input,
		BadgeKind::Plan => SessionBadge::Plan,
		BadgeKind::Failed => SessionBadge::Failed,
		BadgeKind::Due => SessionBadge::Due,
		BadgeKind::Done => SessionBadge::Done,
		BadgeKind::Working => SessionBadge::Working { started_at_ms: NOW_MS - 5_000 },
		BadgeKind::Watching => SessionBadge::Watching,
	}
}

fn block_of(kind: BlockKind) -> ContentBlock {
	match kind {
		BlockKind::Text => ContentBlock::Text { text: "prose".to_string() },
		BlockKind::Image => ContentBlock::Image {
			media_type: "image/png".to_string(),
			data:       vec![0],
			alt:        None,
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

fn agent_blocks(turn: &Turn) -> &[Block] {
	match turn {
		Turn::Agent(blocks) => blocks,
		Turn::Operator(text) => panic!("expected an agent turn, got operator turn {text:?}"),
	}
}

#[test]
fn every_partition_lands_in_its_section_and_a_row_keeps_its_id_across_a_move() {
	let mut store = Store::new();
	for (n, partition) in QueuePartition::ALL.iter().enumerate() {
		store
			.sessions
			.insert(session(&format!("s{n}"), *partition, None));
	}
	let mut index = SessionIndex::new();
	let mut state = ShellState::default();
	project(&store, &mut index, NOW_MS, &mut state);

	let sections: Vec<Section> = state.sections.iter().map(|(section, _)| *section).collect();
	assert_eq!(
		sections,
		[Section::Unsent, Section::Pinned, Section::Live, Section::Deferred, Section::Parked],
		"one section per partition, in queue order"
	);
	for (section, rows) in &state.sections {
		assert_eq!(rows.len(), 1, "{section:?} holds its one session");
	}
	let first_id = state.sections[0].1[0].id;
	assert_ne!(first_id, 0, "zero is the id of no session");

	// Move s0 from Unsent to Parked: the row id follows the session.
	let mut moved = session("s0", QueuePartition::Parked, None);
	moved.title = "moved".to_string();
	store.sessions.insert(moved);
	project(&store, &mut index, NOW_MS, &mut state);
	let parked = &state.sections.last().expect("parked section").1;
	assert!(
		parked
			.iter()
			.any(|row| row.id == first_id && row.title == "moved")
	);
	assert!(
		!state
			.sections
			.iter()
			.any(|(section, _)| *section == Section::Unsent),
		"an emptied partition draws no section"
	);
	assert_eq!(index.session_of(first_id), Some(&SessionId::from("s0")));
}

#[test]
fn every_badge_variant_reaches_the_row_and_the_run_bar() {
	for kind in BadgeKind::iter() {
		let mut store = Store::new();
		store
			.sessions
			.insert(session("s", QueuePartition::Live, Some(badge_of(kind))));
		store.persisted.shell.active_session = Some(SessionId::from("s"));
		let mut state = ShellState::default();
		project(&store, &mut SessionIndex::new(), NOW_MS, &mut state);

		let row = &state.sections[0].1[0];
		let badge = row
			.badge
			.unwrap_or_else(|| panic!("{kind:?} projects no badge"));
		assert_eq!(state.run_status, Some((badge, badge.label().to_string())));
		assert_eq!(state.title, "title s");
		if kind == BadgeKind::Working {
			assert_eq!(row.meta.as_deref(), Some("5s"), "a working row shows its elapsed time");
		} else {
			assert_eq!(row.meta.as_deref(), Some("1m"), "an idle row shows its age");
		}
	}
	let all: Vec<Badge> = vec![
		Badge::Working,
		Badge::Watching,
		Badge::Approval,
		Badge::Input,
		Badge::Plan,
		Badge::Due,
		Badge::Done,
		Badge::Failed,
	];
	assert_eq!(all.len(), BadgeKind::iter().count(), "the two badge vocabularies are the same size");
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
	project(&store, &mut SessionIndex::new(), NOW_MS, &mut state);

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
		project(&store, &mut SessionIndex::new(), NOW_MS, &mut state);
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
	project(&store, &mut SessionIndex::new(), NOW_MS, &mut state);

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
	project(&store, &mut SessionIndex::new(), NOW_MS, &mut state);
	assert_eq!(state.transcript.len(), 1, "a reopen shows the reopened transcript once");
	assert!(matches!(&state.transcript[0], Turn::Operator(text) if text == "d"));
}

#[test]
fn a_projection_leaves_what_the_window_owns_alone() {
	let mut store = Store::new();
	store
		.sessions
		.insert(session("s", QueuePartition::Live, None));
	let mut state = ShellState::default();
	state.composed = "half a sentence".to_string();
	state.drawer_open = true;
	state.tabs = vec!["Files".to_string(), "Changes".to_string()];
	state.active_tab = 1;
	state.drawer_lines = vec!["$ bun test".to_string()];

	project(&store, &mut SessionIndex::new(), NOW_MS, &mut state);

	assert_eq!(state.composed, "half a sentence");
	assert!(state.drawer_open);
	assert_eq!(state.active_tab, 1);
	assert_eq!(state.tabs.len(), 2);
	assert_eq!(state.drawer_lines, ["$ bun test"]);
	assert_eq!(state.sections.len(), 1, "and the host-owned fields were written");
}

#[test]
fn a_pane_is_held_to_its_ceiling_with_the_remainder_counted() {
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	let output: String = (0..PANE_LINE_CEILING + 5)
		.map(|n| format!("line {n}\n"))
		.collect();
	let tree = store.transcripts.entry(SessionId::from("s")).or_default();
	tree.append(entry("a", None, MessageRole::BashExecution, vec![ContentBlock::Execution {
		language: "bash".into(),
		command: Some("seq".into()),
		output,
		exit_code: Some(2),
	}]));
	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), NOW_MS, &mut state);

	let Block::Pane { caption, lines } = &agent_blocks(&state.transcript[0])[0] else {
		panic!("an execution is a pane");
	};
	assert_eq!(caption, "seq · exit 2");
	assert_eq!(lines.len(), PANE_LINE_CEILING + 1);
	assert_eq!(lines.last().map(String::as_str), Some("… 5 more lines"));
}

fn store_with_decisions() -> (Store, SessionIndex) {
	let mut store = Store::new();
	store
		.sessions
		.insert(session("s", QueuePartition::Live, None));
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	store
		.interactions
		.insert(SessionId::from("s"), PendingDecisions {
			approvals: vec![ApprovalInteraction {
				id:              InteractionId::from("i-approve"),
				tool_name:       "bash".to_string(),
				detail:          "rm -rf build\nthen rebuild".to_string(),
				requested_at_ms: NOW_MS,
			}],
			questions: vec![
				QuestionInteraction {
					id:              InteractionId::from("i-ask"),
					prompt:          "Which?".to_string(),
					options:         vec!["left".to_string(), "right".to_string()],
					requested_at_ms: NOW_MS,
				},
				QuestionInteraction {
					id:              InteractionId::from("i-free"),
					prompt:          "Name it".to_string(),
					options:         Vec::new(),
					requested_at_ms: NOW_MS,
				},
			],
			plans:     vec![PlanInteraction {
				id:              InteractionId::from("i-plan"),
				markdown_plan:   "# Ship it\n- step".to_string(),
				requested_at_ms: NOW_MS,
			}],
		});
	let mut index = SessionIndex::new();
	let mut state = ShellState::default();
	project(&store, &mut index, NOW_MS, &mut state);
	assert!(
		matches!(&state.cards[..], [
			Card::Approval { .. },
			Card::Question { .. },
			Card::Question { .. },
			Card::Plan { .. }
		]),
		"approvals, then questions, then plans: {:?}",
		state.cards
	);
	assert!(
		matches!(&state.cards[3], Card::Plan { title, body } if title == "Ship it" && body == &["- step"])
	);
	(store, index)
}

#[test]
fn every_intent_maps_to_the_action_the_host_answers_or_to_none_on_purpose() {
	let (mut store, mut index) = store_with_decisions();
	let row = index.row_of(&SessionId::from("s"));
	let session = SessionId::from("s");

	assert_eq!(
		action_for(&Intent::SelectSession(row), &index, &mut store),
		Some(HostAction::OpenSession { session: session.clone() })
	);
	assert_eq!(action_for(&Intent::SelectSession(999), &index, &mut store), None);
	assert_eq!(
		action_for(&Intent::Send("hello".into()), &index, &mut store),
		Some(HostAction::SubmitPrompt {
			session:     session.clone(),
			text:        "hello".into(),
			attachments: Vec::new(),
		})
	);
	assert_eq!(action_for(&Intent::SelectTab(0), &index, &mut store), None);
	assert_eq!(action_for(&Intent::ToggleDrawer, &index, &mut store), None);

	// Answer the plan (position 3) first: its id is the plan's, and the
	// cards before it keep their positions.
	let plan = action_for(&Intent::Plan { card: 3, accepted: true }, &index, &mut store);
	assert_eq!(
		plan,
		Some(HostAction::RespondToInteraction {
			session:        session.clone(),
			interaction_id: "i-plan".into(),
			response:       serde_json::json!({ "accepted": true }),
		})
	);
	let answer = action_for(&Intent::Answer { card: 1, option: 1 }, &index, &mut store);
	assert_eq!(
		answer,
		Some(HostAction::RespondToInteraction {
			session:        session.clone(),
			interaction_id: "i-ask".into(),
			response:       serde_json::json!({ "option": 1, "text": "right" }),
		})
	);
	// The free-text question moved up to position 1 and takes the composer's
	// text as its answer.
	let reply = action_for(&Intent::Reply { card: 1, text: "widget".into() }, &index, &mut store);
	assert_eq!(
		reply,
		Some(HostAction::RespondToInteraction {
			session:        session.clone(),
			interaction_id: "i-free".into(),
			response:       serde_json::json!({ "text": "widget" }),
		})
	);
	// The approval is now the only card, at position 0, in both stacks.
	let approval = action_for(
		&Intent::Approval { card: 0, approved: false, standing: false },
		&index,
		&mut store,
	);
	assert_eq!(
		approval,
		Some(HostAction::RespondToInteraction {
			session:        session.clone(),
			interaction_id: "i-approve".into(),
			response:       serde_json::json!({ "approved": false, "scope": "once" }),
		})
	);
	assert_eq!(
		action_for(&Intent::Approval { card: 0, approved: true, standing: true }, &index, &mut store),
		None,
		"an answered card is not answered twice"
	);
	assert!(store.interactions[&session].is_empty());
}

#[test]
fn a_decision_at_a_position_of_the_wrong_kind_is_dropped_not_misdelivered() {
	let (mut store, index) = store_with_decisions();
	// Position 0 is the approval; asking to answer it as a question must not
	// resolve the approval with a question's payload.
	assert_eq!(action_for(&Intent::Answer { card: 0, option: 0 }, &index, &mut store), None);
	assert_eq!(action_for(&Intent::Plan { card: 1, accepted: true }, &index, &mut store), None);
	assert_eq!(
		action_for(&Intent::Reply { card: 0, text: "no".into() }, &index, &mut store),
		None,
		"a reply is a question's answer, never an approval's"
	);
	assert_eq!(
		action_for(&Intent::Answer { card: 1, option: 5 }, &index, &mut store),
		None,
		"an option that does not exist is not sent"
	);
	let pending = &store.interactions[&SessionId::from("s")];
	assert_eq!(
		(pending.approvals.len(), pending.questions.len(), pending.plans.len()),
		(1, 1, 1),
		"the mis-kinded answers took nothing; the bad option took its question"
	);
}
