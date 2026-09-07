//! Fixtures the badge suites share: one session as the host lists it, the
//! decisions and processes a badge is derived from, and the seeding that puts
//! a store into exactly one badge's state.
#![allow(dead_code, reason = "each suite uses a subset of these fixtures")]

use veyyon_desktop_model::{
	ApprovalInteraction, BadgeKind, ContentBlock, EntryId, HostEvent, InteractionId, MessageRole,
	PendingDecisions, PlanInteraction, ProcessView, QuestionInteraction, QueuePartition, Session,
	SessionBadge, SessionHeaderView, SessionId, SessionStatus, SessionSummary, SnapshotSection,
	Store, TranscriptEntry, Versioned, reduce,
};

pub const NOW_MS: u64 = 1_700_000_100_000;
pub const WROTE_MS: u64 = NOW_MS - 30_000;

pub fn session_id() -> SessionId {
	SessionId::from("session_0001")
}

/// A read session whose last turn finished: the state that derives no badge.
pub fn read_session() -> Session {
	Session {
		id:                session_id(),
		title:             "Rewrite the walker cache".to_string(),
		project_name:      "veyyon".to_string(),
		branch:            String::new(),
		partition:         QueuePartition::Live,
		status:            SessionStatus::Complete,
		created_at_ms:     NOW_MS - 600_000,
		modified_at_ms:    WROTE_MS,
		read_mark_ms:      Some(WROTE_MS),
		last_recall_at_ms: NOW_MS - 600_000,
		defer_until_ms:    None,
		parked_at_ms:      None,
		pin_key:           None,
	}
}

pub fn store_with_session() -> Store {
	let mut store = Store::new();
	store.sessions.insert(read_session());
	store.persisted.shell.active_session = Some(session_id());
	store
}

pub fn approval() -> ApprovalInteraction {
	ApprovalInteraction {
		id:              InteractionId::from("interaction_0001"),
		tool_name:       "bash".to_string(),
		detail:          "rm -rf build".to_string(),
		requested_at_ms: WROTE_MS,
	}
}

pub fn question() -> QuestionInteraction {
	QuestionInteraction {
		id:              InteractionId::from("interaction_0002"),
		prompt:          "Which provider?".to_string(),
		options:         vec!["A".to_string(), "B".to_string()],
		requested_at_ms: WROTE_MS,
	}
}

pub fn plan() -> PlanInteraction {
	PlanInteraction {
		id:              InteractionId::from("interaction_0003"),
		markdown_plan:   "1. Measure".to_string(),
		requested_at_ms: WROTE_MS,
	}
}

pub fn live_process() -> ProcessView {
	ProcessView {
		name:          "dev".to_string(),
		pid:           Some(4242),
		status:        "running".to_string(),
		application:   "bun".to_string(),
		args:          vec!["run".to_string(), "dev".to_string()],
		cwd:           "/repo".to_string(),
		lifetime:      "last-client-exit".to_string(),
		started_at_ms: WROTE_MS,
		exit_code:     None,
		terminated_by: None,
	}
}

pub fn user_entry(timestamp_ms: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from("entry_0001"),
		parent: None,
		revision: 1,
		timestamp_ms,
		role: MessageRole::User,
		content: vec![ContentBlock::Text { text: "count to two hundred".to_string() }],
		meta: None,
		raw_discriminator: "User".to_string(),
		raw: serde_json::Value::Null,
	}
}

/// Seeds the state one badge is derived from, and nothing that derives another.
pub fn seed_for(kind: BadgeKind) -> Store {
	let mut store = store_with_session();
	let id = session_id();
	match kind {
		BadgeKind::Approval => {
			store.interactions.insert(id, PendingDecisions {
				approvals: vec![approval()],
				..PendingDecisions::new()
			});
		},
		BadgeKind::Input => {
			store.interactions.insert(id, PendingDecisions {
				questions: vec![question()],
				..PendingDecisions::new()
			});
		},
		BadgeKind::Plan => {
			store
				.interactions
				.insert(id, PendingDecisions { plans: vec![plan()], ..PendingDecisions::new() });
		},
		BadgeKind::Failed => unread(&mut store, SessionStatus::Error),
		BadgeKind::Done => unread(&mut store, SessionStatus::Complete),
		BadgeKind::Due => {
			store.sessions.defer(&id, Some(NOW_MS - 1000));
		},
		BadgeKind::Working => unread(&mut store, SessionStatus::Pending),
		BadgeKind::Watching => store.domains.processes = vec![live_process()],
	}
	store
}

/// Reports a status for a session written since the operator last read it.
pub fn unread(store: &mut Store, status: SessionStatus) {
	if let Some(session) = store.sessions.get_mut(&session_id()) {
		session.status = status;
		session.modified_at_ms = WROTE_MS;
		session.read_mark_ms = Some(WROTE_MS - 1000);
	}
}

pub fn kind_of(badge: &SessionBadge) -> BadgeKind {
	BadgeKind::from(badge)
}

/// The host's summary for a session, as the index lists it.
pub fn summary(status: SessionStatus, modified_at_ms: u64) -> SessionSummary {
	SessionSummary {
		id: session_id(),
		workspace: "veyyon".to_string(),
		path: "/repo/.veyyon/sessions/session_0001.jsonl".to_string(),
		cwd: "/repo".to_string(),
		title: Some("Rewrite the walker cache".to_string()),
		parent_path: None,
		created_at_ms: NOW_MS - 600_000,
		modified_at_ms,
		message_count: 4,
		size_bytes: 512,
		first_message: Some("hello".to_string()),
		searchable_messages: Some("hello".to_string()),
		status,
	}
}

/// Reduces one session index listing the session at a status.
pub fn list(store: &mut Store, status: SessionStatus, modified_at_ms: u64) {
	reduce(
		store,
		HostEvent::Snapshot(SnapshotSection::Sessions(
			Versioned { revision: 1, value: vec![summary(status, modified_at_ms)] },
			Vec::new(),
		)),
	);
}

/// Reduces the header the host sends when the operator opens the session.
pub fn open(store: &mut Store) {
	reduce(
		store,
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 2,
			value:    SessionHeaderView {
				id:             session_id(),
				schema_version: 1,
				title:          Some("Rewrite the walker cache".to_string()),
				title_source:   None,
				parent:         None,
				created_at_ms:  NOW_MS - 600_000,
				cwd:            "/repo".to_string(),
			},
		})),
	);
}
