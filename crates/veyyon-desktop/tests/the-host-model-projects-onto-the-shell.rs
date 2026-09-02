//! WHY: the window drew a fixture. Nothing turned what the host reported into
//! what the surfaces draw, so a session the host listed, a turn it streamed
//! and a decision it asked for reached no pixel. `project` and `actions_for`
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

use std::{collections::HashMap, fmt::Write as _, path::PathBuf};

use strum::IntoEnumIterator as _;
use veyyon_desktop::{PANE_LINE_CEILING, SessionIndex, actions_for, drawer_lines, project};
use veyyon_desktop_model::{
	ApprovalInteraction, AttachmentSubmission, BadgeKind, BlockKind, Capability, CapabilityStatus,
	ChangeScope, ChangeStatus, ChangedFile, ChangesView, ComposerDraft, ContentBlock,
	ContextBreakdownView, EntryId, HostAction, HostEvent, InputModality, InteractionId, MessageRole,
	ModelRef, ModelView, ModelsView, PendingDecisions, PlanInteraction, QuestionInteraction,
	QueueMode, QueuePartition, Session, SessionBadge, SessionId, SnapshotSection, Store,
	StreamingMessageState, TerminalOutputChunk, TerminalStatus, TerminalView, TranscriptEntry,
	Versioned, reduce,
};
use veyyon_desktop_surface::{
	Attachment, Badge, Block, Card, Intent, MediaType, Section, ShellState, Turn,
	composer::payload_for,
};

/// One tree row as the assertions read it: depth, name, line counts.
type TreeCell<'a> = (usize, &'a str, Option<(u32, u32)>);

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

const fn badge_of(kind: BadgeKind) -> SessionBadge {
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
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);

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
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
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
		project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

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
fn a_projection_leaves_what_the_window_owns_alone() {
	let mut store = Store::new();
	store
		.sessions
		.insert(session("s", QueuePartition::Live, None));
	let mut state = ShellState {
		drawer_open: true,
		panel: veyyon_desktop_surface::PanelContent {
			active_tab: veyyon_desktop_surface::PanelTab::File,
			diff_mode: veyyon_desktop_model::DiffMode::Split,
			..veyyon_desktop_surface::PanelContent::default()
		},
		..ShellState::default()
	};

	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	assert!(state.drawer_open);
	assert_eq!(state.panel.active_tab, veyyon_desktop_surface::PanelTab::File);
	assert_eq!(state.panel.diff_mode, veyyon_desktop_model::DiffMode::Split);
	assert_eq!(state.sections.len(), 1, "and the host-owned fields were written");
	assert_eq!(state.drawer.tabs.len(), 0, "the drawer shows the host's terminal");
}

fn changed(path: &str, additions: u64, deletions: u64) -> ChangedFile {
	ChangedFile {
		path: path.to_string(),
		previous_path: None,
		status: ChangeStatus::Modified,
		additions,
		deletions,
	}
}

#[test]
fn a_changes_snapshot_becomes_a_tree_with_each_directory_opened_once() {
	let mut store = Store::new();
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Changes(ChangesView {
			revision:   1,
			repository: Some("/repo".to_string()),
			scope:      ChangeScope::WorkingTree,
			files:      vec![
				changed("src/b/two.rs", 2, 0),
				changed("README.md", 1, 1),
				changed("src/a/one.rs", 3, 4),
				changed("src/a/zero.rs", 0, 9),
			],
			diff:       String::new(),
		})),
	);
	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	let rows: Vec<TreeCell<'_>> = state
		.panel
		.tree
		.rows
		.iter()
		.map(|row| (row.depth, row.name.as_str(), row.changed))
		.collect();
	assert_eq!(rows, [
		(0, "README.md", Some((1, 1))),
		(0, "src", None),
		(1, "a", None),
		(2, "one.rs", Some((3, 4))),
		(2, "zero.rs", Some((0, 9))),
		(1, "b", None),
		(2, "two.rs", Some((2, 0))),
	]);

	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Changes(ChangesView {
			revision:   2,
			repository: Some("/repo".to_string()),
			scope:      ChangeScope::Staged,
			files:      Vec::new(),
			diff:       String::new(),
		})),
	);
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	assert!(
		state.panel.tree.rows.is_empty(),
		"a later snapshot replaces the tree, it does not add to it"
	);
}

fn terminal(id: &str, status: TerminalStatus) -> TerminalView {
	TerminalView {
		id: id.to_string(),
		cwd: "/repo".to_string(),
		shell: "/bin/sh".to_string(),
		cols: 80,
		rows: 24,
		status,
	}
}

fn output(terminal: &str, seq: u64, data: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::TerminalOutput(TerminalOutputChunk {
		terminal: terminal.to_string(),
		seq,
		data: data.as_bytes().to_vec(),
		reset: false,
	}))
}

#[test]
fn the_drawer_shows_the_last_running_terminal_as_plain_text_from_the_end() {
	let mut store = Store::new();
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Terminals(vec![
			terminal("t1", TerminalStatus::Running),
			terminal("t2", TerminalStatus::Running),
			terminal("t3", TerminalStatus::Exited { code: 0 }),
		])),
	);
	reduce(&mut store, output("t1", 1, "first terminal\n"));
	reduce(&mut store, output("t3", 1, "exited terminal\n"));
	let mut long = String::new();
	for n in 0..PANE_LINE_CEILING + 3 {
		write!(long, "\u{1b}[32mline {n}\u{1b}[0m\r\n").unwrap();
	}
	reduce(&mut store, output("t2", 1, &long));
	reduce(&mut store, output("t2", 2, "\u{1b}]0;title\u{07}$ done"));

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	let lines = drawer_lines(&store.domains);
	assert_eq!(lines.len(), PANE_LINE_CEILING, "held to the pane ceiling");
	assert_eq!(lines[0], "line 4", "the lines dropped are the oldest");
	assert_eq!(lines.last().map(String::as_str), Some("$ done"));
	assert!(
		lines
			.iter()
			.all(|line| !line.contains('\u{1b}') && !line.contains('\r')),
		"control sequences never reach the drawer"
	);
	assert_eq!(state.drawer.tabs.len(), 3, "drawer projects 3 terminal tabs");
	assert_eq!(state.drawer.title, "title", "drawer projects title from OSC");
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Terminals(vec![terminal(
			"t3",
			TerminalStatus::Exited { code: 0 },
		)])),
	);
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	let lines2 = drawer_lines(&store.domains);
	assert_eq!(lines2, ["exited terminal"], "with nothing running, the last one opened");
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
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
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
fn every_intent_maps_to_the_actions_the_host_answers_or_to_none_on_purpose() {
	let (mut store, mut index) = store_with_decisions();
	let row = index.row_of(&SessionId::from("s"));
	let session = SessionId::from("s");

	assert_eq!(
		actions_for(&Intent::SelectSession(row), &index, &mut store),
		[HostAction::OpenSession { session: session.clone() }, HostAction::RefreshChanges],
		"opening a session also asks for the changes the panel shows"
	);
	assert!(actions_for(&Intent::SelectSession(999), &index, &mut store).is_empty());
	assert_eq!(
		actions_for(
			&Intent::Send { text: "hello".into(), attachments: Vec::new() },
			&index,
			&mut store
		),
		[HostAction::SubmitPrompt {
			session:     session.clone(),
			text:        "hello".into(),
			attachments: Vec::new(),
		}]
	);
	// An attachment reaches the host with its bytes, its sniffed media type
	// and an id that distinguishes two chips carrying the same file.
	let png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
	let picked = Attachment::from_path(
		PathBuf::from("/repo/shot.png"),
		MediaType::Png,
		payload_for(MediaType::Png, png.clone()),
	);
	let pasted =
		Attachment::from_clipboard(2, MediaType::Png, payload_for(MediaType::Png, png.clone()));
	assert_eq!(
		actions_for(
			&Intent::Send { text: "look".into(), attachments: vec![picked, pasted] },
			&index,
			&mut store
		),
		[HostAction::SubmitPrompt {
			session:     session.clone(),
			text:        "look".into(),
			attachments: vec![
				AttachmentSubmission {
					id:         "0:/repo/shot.png".into(),
					name:       "shot.png".into(),
					media_type: "image/png".into(),
					data:       png.clone(),
				},
				AttachmentSubmission {
					id:         "1:clipboard:2".into(),
					name:       "Pasted image 2.png".into(),
					media_type: "image/png".into(),
					data:       png,
				},
			],
		}]
	);
	assert!(actions_for(&Intent::SelectTab(0), &index, &mut store).is_empty());
	assert!(actions_for(&Intent::SetDrawer { open: false }, &index, &mut store).is_empty());

	// Answer the plan (position 3) first: its id is the plan's, and the
	// cards before it keep their positions.
	let plan = actions_for(&Intent::Plan { card: 3, accepted: true }, &index, &mut store);
	assert_eq!(plan, [HostAction::RespondToInteraction {
		session:        session.clone(),
		interaction_id: "i-plan".into(),
		response:       serde_json::json!({ "accepted": true }),
	}]);
	let answer = actions_for(&Intent::Answer { card: 1, option: 1 }, &index, &mut store);
	assert_eq!(answer, [HostAction::RespondToInteraction {
		session:        session.clone(),
		interaction_id: "i-ask".into(),
		response:       serde_json::json!({ "option": 1, "text": "right" }),
	}]);
	// The free-text question moved up to position 1 and takes the composer's
	// text as its answer.
	let reply = actions_for(&Intent::Reply { card: 1, text: "widget".into() }, &index, &mut store);
	assert_eq!(reply, [HostAction::RespondToInteraction {
		session:        session.clone(),
		interaction_id: "i-free".into(),
		response:       serde_json::json!({ "text": "widget" }),
	}]);
	// The approval is now the only card, at position 0, in both stacks.
	let approval = actions_for(
		&Intent::Approval { card: 0, approved: false, standing: false },
		&index,
		&mut store,
	);
	assert_eq!(approval, [HostAction::RespondToInteraction {
		session:        session.clone(),
		interaction_id: "i-approve".into(),
		response:       serde_json::json!({ "approved": false, "scope": "once" }),
	}]);
	assert!(
		actions_for(
			&Intent::Approval { card: 0, approved: true, standing: true },
			&index,
			&mut store
		)
		.is_empty(),
		"an answered card is not answered twice"
	);
	assert!(store.interactions[&session].is_empty());
}

#[test]
fn opening_the_drawer_attaches_to_the_running_terminal_or_creates_one() {
	let (mut store, index) = store_with_decisions();
	assert_eq!(
		actions_for(&Intent::SetDrawer { open: true }, &index, &mut store),
		[HostAction::CreateTerminal { cwd: None, shell: None }],
		"with no terminal, the drawer asks for one"
	);
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Terminals(vec![
			terminal("t1", TerminalStatus::Running),
			terminal("t2", TerminalStatus::Exited { code: 1 }),
		])),
	);
	assert_eq!(
		actions_for(&Intent::SetDrawer { open: true }, &index, &mut store),
		[HostAction::AttachTerminal { terminal_id: "t1".into() }],
		"with one running, the drawer attaches to it and replays its scrollback"
	);
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Terminals(vec![terminal(
			"t1",
			TerminalStatus::Failed { message: "no shell".into() },
		)])),
	);
	assert_eq!(
		actions_for(&Intent::SetDrawer { open: true }, &index, &mut store),
		[HostAction::CreateTerminal { cwd: None, shell: None }],
		"a terminal that failed is not one to attach to"
	);
}

#[test]
fn a_decision_at_a_position_of_the_wrong_kind_is_dropped_not_misdelivered() {
	let (mut store, index) = store_with_decisions();
	// Position 0 is the approval; asking to answer it as a question must not
	// resolve the approval with a question's payload.
	assert!(actions_for(&Intent::Answer { card: 0, option: 0 }, &index, &mut store).is_empty());
	assert!(actions_for(&Intent::Plan { card: 1, accepted: true }, &index, &mut store).is_empty());
	assert!(
		actions_for(&Intent::Reply { card: 0, text: "no".into() }, &index, &mut store).is_empty(),
		"a reply is a question's answer, never an approval's"
	);
	assert!(
		actions_for(&Intent::Answer { card: 1, option: 5 }, &index, &mut store).is_empty(),
		"an option that does not exist is not sent"
	);
	let pending = &store.interactions[&SessionId::from("s")];
	assert_eq!(
		(pending.approvals.len(), pending.questions.len(), pending.plans.len()),
		(1, 1, 1),
		"the mis-kinded answers took nothing; the bad option took its question"
	);
}

#[test]
fn the_footer_shows_the_model_thinking_and_context_the_host_reported() {
	let mut store = Store::new();
	let session_id = SessionId::from("s");
	store
		.sessions
		.insert(session("s", QueuePartition::Live, None));
	store.persisted.shell.active_session = Some(session_id.clone());
	store
		.capabilities
		.set(Capability::Models, CapabilityStatus::Available);
	store.domains.models = Some(ModelsView {
		models:          vec![ModelView {
			provider:       "anthropic".into(),
			id:             "claude-sonnet-4.5".into(),
			name:           "Claude Sonnet 4.5".into(),
			reasoning:      true,
			context_window: 200_000,
			max_output:     64_000,
			input:          vec![InputModality::Text, InputModality::Image],
		}],
		current:         Some(ModelRef {
			provider: "anthropic".into(),
			id:       "claude-sonnet-4.5".into(),
		}),
		thinking_level:  Some("high".into()),
		thinking_levels: ["off", "low", "medium", "high"].map(str::to_owned).to_vec(),
	});
	store
		.domains
		.context
		.insert(session_id.clone(), ContextBreakdownView {
			session:      session_id.clone(),
			total_tokens: 82_400,
			limit_tokens: Some(200_000),
			categories:   Vec::new(),
		});
	store
		.composer_drafts
		.insert(session_id, ComposerDraft { queue_mode: QueueMode::Queue, ..ComposerDraft::new() });

	// What the window owns is not the host's to overwrite: the attachment the
	// operator added survives the frame that reports a new model.
	let mut state = ShellState::default();
	state.composer.attachments.push(Attachment::from_clipboard(
		1,
		MediaType::Png,
		payload_for(MediaType::Png, vec![0x89, b'P', b'N', b'G']),
	));
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	let model = state
		.composer
		.model
		.as_ref()
		.expect("the models view projects");
	assert!(model.selectable, "the host accepts SelectModel");
	assert_eq!(model.label(), Some("Claude Sonnet 4.5"));
	assert_eq!(
		model.accepts(InputModality::Video),
		Some(false),
		"the catalog lists the model without video, so a clip flags unsupported"
	);
	let thinking = state
		.composer
		.thinking
		.as_ref()
		.expect("the levels project");
	assert_eq!(thinking.level, "high");
	assert_eq!(thinking.next(), Some("off"), "cycling wraps to the first level");
	assert_eq!(
		state.composer.context.and_then(|meter| meter.percent()),
		Some(41),
		"82.4k of 200k is 41% context"
	);
	assert_eq!(state.composer.queue_mode, QueueMode::Queue, "the draft's mode projects");
	assert_eq!(state.composer.attachments.len(), 1, "the frame left the window's attachments");

	// A host that never answered the Models capability gets a label naming the
	// active model and no picker (§5.13).
	store
		.capabilities
		.set(Capability::Models, CapabilityStatus::UnknownUntilAttached);
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	assert!(
		!state
			.composer
			.model
			.as_ref()
			.expect("the models view still projects")
			.selectable,
		"an unknown capability is not permission to send SelectModel"
	);
}
