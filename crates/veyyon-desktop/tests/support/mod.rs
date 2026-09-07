//! Fixtures for the suites that drive `project` and `actions_for` from a
//! synthetic store. Each suite pulls in only what it uses, so a helper unused
//! by one binary is expected.
#![allow(dead_code, reason = "each test binary uses a subset of these fixtures")]

pub mod raster;

use veyyon_desktop_model::{
	ApprovalInteraction, BadgeKind, ContentBlock, EntryId, InteractionId, MessageRole,
	PlanInteraction, ProcessView, QuestionInteraction, QueuePartition, Session, SessionId,
	SessionStatus, Store, StreamingMessageState, TerminalStatus, TerminalView, TranscriptEntry,
};
use veyyon_desktop_surface::{Block, Turn};

pub const NOW_MS: u64 = 10_000_000;

/// A session the operator has read whose last turn finished, which is the
/// state that derives no badge.
pub fn session(id: &str, partition: QueuePartition) -> Session {
	Session {
		id: SessionId::from(id),
		title: format!("title {id}"),
		project_name: "repo".to_string(),
		branch: String::new(),
		partition,
		status: SessionStatus::Complete,
		created_at_ms: NOW_MS - 120_000,
		modified_at_ms: NOW_MS - 60_000,
		read_mark_ms: Some(NOW_MS - 60_000),
		last_recall_at_ms: NOW_MS - 60_000,
		defer_until_ms: None,
		parked_at_ms: None,
		pin_key: None,
	}
}

/// The state one row badge is derived from, and the detail the run bar states
/// beside it. Every arm seeds what `session_badge` reads and nothing else.
pub fn seed_badge(store: &mut Store, id: &str, kind: BadgeKind) -> &'static str {
	let session_id = SessionId::from(id);
	match kind {
		BadgeKind::Approval => {
			store
				.interactions
				.entry(session_id)
				.or_default()
				.approvals
				.push(ApprovalInteraction {
					id:              InteractionId::from("interaction_0001"),
					tool_name:       "bash".to_string(),
					detail:          "rm -rf build".to_string(),
					requested_at_ms: NOW_MS - 5_000,
				});
			"bash · rm -rf build"
		},
		BadgeKind::Input => {
			store
				.interactions
				.entry(session_id)
				.or_default()
				.questions
				.push(QuestionInteraction {
					id:              InteractionId::from("interaction_0002"),
					prompt:          "Which provider?".to_string(),
					options:         vec!["A".to_string()],
					requested_at_ms: NOW_MS - 5_000,
				});
			"Which provider?"
		},
		BadgeKind::Plan => {
			store
				.interactions
				.entry(session_id)
				.or_default()
				.plans
				.push(PlanInteraction {
					id:              InteractionId::from("interaction_0003"),
					markdown_plan:   "1. Measure\n2. Cut".to_string(),
					requested_at_ms: NOW_MS - 5_000,
				});
			"1. Measure"
		},
		BadgeKind::Failed => {
			unread_status(store, &session_id, SessionStatus::Error);
			""
		},
		BadgeKind::Done => {
			unread_status(store, &session_id, SessionStatus::Complete);
			""
		},
		BadgeKind::Due => {
			store.sessions.defer(&session_id, Some(NOW_MS - 1_000));
			""
		},
		BadgeKind::Working => {
			// A running turn is a stream, and the tool it is running is what
			// the badge itself cannot state.
			// The file was last written when the turn started, which is what
			// the elapsed counter reads with no transcript loaded.
			if let Some(session) = store.sessions.get_mut(&session_id) {
				session.modified_at_ms = NOW_MS - 5_000;
			}
			store.streaming.insert(session_id, StreamingMessageState {
				entry:        EntryId::from("stream-1"),
				tool:         Some("bash".to_string()),
				accumulating: entry("stream-1", None, MessageRole::Assistant, vec![
					ContentBlock::Text { text: "partial".to_string() },
				]),
				revision:     2,
			});
			"bash"
		},
		BadgeKind::Watching => {
			store.domains.processes = vec![ProcessView {
				name:          "dev".to_string(),
				pid:           Some(4242),
				status:        "running".to_string(),
				application:   "bun".to_string(),
				args:          vec!["run".to_string(), "dev".to_string()],
				cwd:           "/repo".to_string(),
				lifetime:      "last-client-exit".to_string(),
				started_at_ms: NOW_MS - 5_000,
				exit_code:     None,
				terminated_by: None,
			}];
			"dev"
		},
	}
}

/// A status the host reported after the operator last read the session.
fn unread_status(store: &mut Store, id: &SessionId, status: SessionStatus) {
	if let Some(session) = store.sessions.get_mut(id) {
		session.status = status;
		session.modified_at_ms = NOW_MS - 5_000;
		session.read_mark_ms = Some(NOW_MS - 6_000);
	}
}

pub fn entry(
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

pub fn terminal(id: &str, status: TerminalStatus) -> TerminalView {
	TerminalView {
		id: id.to_string(),
		cwd: "/repo".to_string(),
		shell: "/bin/sh".to_string(),
		cols: 80,
		rows: 24,
		status,
	}
}

pub fn agent_blocks(turn: &Turn) -> &[Block] {
	match turn {
		Turn::Agent { blocks, .. } => blocks,
		Turn::Operator(text) | Turn::OperatorArtifacts { text, .. } => {
			panic!("expected an agent turn, got operator turn {text:?}")
		},
	}
}
