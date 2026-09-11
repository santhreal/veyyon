//! WHY: `reduce_request_failed` took the host's `BackendError` and dropped it.
//! A request refused while its control was not on screen -- a settings field
//! under a closed sheet, a queue row in a collapsed rail -- failed with
//! nothing anywhere stating that it had. The same hole ran the other way for a
//! decision: a tool asking for approval on a session that is not the open one
//! drew its card in a transcript nobody was reading.
//!
//! CLASS CLOSED: an event that changes something out of view and announces
//! nothing, and the reverse defect of a card that is announced and then never
//! comes down. Every path into the queue and every path out of it is driven
//! through `reduce`, on the events the host actually sends: the refusal, the
//! pending set, the answered set, and the session being opened.
//!
//! NOT CAUGHT: a fatal protocol error, which is deliberately not announced --
//! it takes the connection to `ConnectionState::Fatal`, which the titlebar
//! line states and the whole window repaints for. Queue mechanics (dedupe,
//! order, expiry, bound) are in the queue suite; what the window draws from
//! the queue is the surface suite.

use veyyon_desktop_model::{
	ApprovalInteraction, BackendError, Damage, ErrorScope, HostEvent, InteractionId,
	NotificationPriority, NotificationSource, PendingDecisions, PlanInteraction,
	QuestionInteraction, RequestId, SessionHeaderView, SessionId, SnapshotSection, Store, Versioned,
	reduce,
};

const NOW_MS: u64 = 1_700_000_000_000;

fn refusal(scope: ErrorScope, code: Option<&str>, message: &str) -> HostEvent {
	HostEvent::RequestFailed {
		request: RequestId(7),
		error:   BackendError {
			scope,
			code: code.map(str::to_owned),
			message: message.to_owned(),
			retryable: true,
			request: Some(RequestId(7)),
			occurred_at_ms: NOW_MS,
		},
	}
}

fn pending(session: &str, pending: PendingDecisions) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Interactions { session: SessionId::from(session), pending })
}

fn approval(id: &str, tool: &str) -> ApprovalInteraction {
	ApprovalInteraction {
		id:              InteractionId::from(id),
		tool_name:       tool.to_owned(),
		detail:          "rm -rf build".to_owned(),
		requested_at_ms: NOW_MS,
	}
}

fn opened(store: &mut Store, id: &str) {
	reduce(
		store,
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 1,
			value:    SessionHeaderView {
				id:             SessionId::from(id),
				schema_version: 1,
				title:          Some("Rewrite the walker cache".to_owned()),
				title_source:   None,
				parent:         None,
				created_at_ms:  NOW_MS - 600_000,
				cwd:            "/repo".to_owned(),
				mode:           None,
			},
		})),
	);
}

#[test]
fn a_refused_request_is_announced_with_what_the_host_said_and_where_it_landed() {
	let mut store = Store::new();
	let damage = reduce(&mut store, refusal(ErrorScope::Settings, Some("EACCES"), "cannot write"));

	assert!(
		damage.contains(&Damage::Notifications),
		"the stack is repainted for the card that just arrived"
	);
	assert_eq!(store.notifications.len(), 1);
	let held = &store.notifications.raised()[0];
	assert_eq!(held.title, "cannot write", "the card states what the host said, verbatim");
	assert_eq!(
		held.detail.as_deref(),
		Some(ErrorScope::Settings.as_str()),
		"and where the refusal landed"
	);
	assert_eq!(held.source, NotificationSource::RequestFailed);
	assert_eq!(held.priority, NotificationPriority::Normal);
	assert_eq!(held.raised_at_ms, NOW_MS, "on the host's clock, not the window's");
	assert!(held.key.contains(ErrorScope::Settings.as_str()) && held.key.contains("EACCES"));
}

#[test]
fn one_control_failing_in_a_loop_announces_once_and_another_scope_is_its_own_card() {
	let mut store = Store::new();
	for _ in 0..40 {
		reduce(&mut store, refusal(ErrorScope::Provider, Some("429"), "rate limited"));
	}
	assert_eq!(store.notifications.len(), 1, "forty refusals of one thing are one announcement");

	reduce(&mut store, refusal(ErrorScope::Terminal, Some("429"), "rate limited"));
	assert_eq!(store.notifications.len(), 2, "a refusal from another scope is another announcement");

	reduce(&mut store, refusal(ErrorScope::Provider, None, "rate limited"));
	assert_eq!(
		store.notifications.len(),
		3,
		"a refusal the host put no code on is not merged into one that has a code"
	);
}

#[test]
fn a_fatal_protocol_error_is_not_announced_because_the_connection_line_states_it() {
	let mut store = Store::new();
	let damage =
		reduce(&mut store, HostEvent::FatalProtocolError { message: "frame too large".to_owned() });
	assert!(store.notifications.is_empty(), "a fatal error is stated by the window, not a card");
	assert!(
		!damage.contains(&Damage::Notifications),
		"and the stack is not repainted for something that never reached it"
	);
}

#[test]
fn a_decision_waiting_on_a_session_that_is_not_open_is_announced_once() {
	let mut store = Store::new();
	opened(&mut store, "open");

	let damage = reduce(
		&mut store,
		pending("other", PendingDecisions {
			approvals: vec![approval("a-1", "bash")],
			questions: vec![QuestionInteraction {
				id:              InteractionId::from("q-1"),
				prompt:          "Which branch?".to_owned(),
				options:         vec!["main".to_owned()],
				requested_at_ms: NOW_MS,
			}],
			plans:     vec![PlanInteraction {
				id:              InteractionId::from("p-1"),
				markdown_plan:   "# Ship it".to_owned(),
				requested_at_ms: NOW_MS,
			}],
		}),
	);
	assert!(damage.contains(&Damage::Notifications));
	assert_eq!(store.notifications.len(), 3, "each decision is its own announcement");

	let titles: Vec<&str> = store
		.notifications
		.raised()
		.iter()
		.map(|held| held.title.as_str())
		.collect();
	assert!(titles.contains(&"bash is waiting for approval"), "{titles:?}");
	assert!(titles.contains(&"Which branch?"), "{titles:?}");
	assert!(titles.contains(&"A plan is waiting for review"), "{titles:?}");
	for held in store.notifications.raised() {
		assert_eq!(held.source, NotificationSource::DecisionWaiting);
		assert_eq!(
			held.priority,
			NotificationPriority::Urgent,
			"a turn waiting on an answer is not taken down by a clock"
		);
		assert_eq!(held.expires_at_ms(), None);
	}

	// The host restates the pending set on every snapshot for the session.
	reduce(
		&mut store,
		pending("other", PendingDecisions {
			approvals: vec![approval("a-1", "bash")],
			questions: Vec::new(),
			plans:     Vec::new(),
		}),
	);
	assert_eq!(
		store.notifications.len(),
		1,
		"restating one decision neither announces it twice nor keeps the answered ones up"
	);
	assert_eq!(store.notifications.raised()[0].title, "bash is waiting for approval");
}

#[test]
fn a_decision_on_the_open_session_is_read_rather_than_announced() {
	let mut store = Store::new();
	opened(&mut store, "open");
	let damage = reduce(
		&mut store,
		pending("open", PendingDecisions {
			approvals: vec![approval("a-1", "bash")],
			questions: Vec::new(),
			plans:     Vec::new(),
		}),
	);
	assert!(store.notifications.is_empty(), "the card is above the composer in front of them");
	assert!(!damage.contains(&Damage::Notifications));
}

#[test]
fn answering_a_decision_takes_its_card_down() {
	let mut store = Store::new();
	opened(&mut store, "open");
	reduce(
		&mut store,
		pending("other", PendingDecisions {
			approvals: vec![approval("a-1", "bash")],
			questions: Vec::new(),
			plans:     Vec::new(),
		}),
	);
	assert_eq!(store.notifications.len(), 1);

	let damage = reduce(&mut store, pending("other", PendingDecisions::default()));
	assert!(
		store.notifications.is_empty(),
		"an answered decision is waiting on nothing, so nothing announces it"
	);
	assert!(damage.contains(&Damage::Notifications));
}

#[test]
fn opening_the_session_takes_down_every_card_about_it_and_leaves_the_others() {
	let mut store = Store::new();
	opened(&mut store, "open");
	reduce(
		&mut store,
		pending("other", PendingDecisions {
			approvals: vec![approval("a-1", "bash"), approval("a-2", "edit")],
			questions: Vec::new(),
			plans:     Vec::new(),
		}),
	);
	reduce(
		&mut store,
		pending("third", PendingDecisions {
			approvals: vec![approval("a-3", "write")],
			questions: Vec::new(),
			plans:     Vec::new(),
		}),
	);
	reduce(&mut store, refusal(ErrorScope::Settings, Some("EACCES"), "cannot write"));
	assert_eq!(store.notifications.len(), 4);

	opened(&mut store, "other");
	let keys: Vec<&str> = store
		.notifications
		.raised()
		.iter()
		.map(|held| held.key.as_str())
		.collect();
	assert_eq!(keys.len(), 2, "both of that session's cards went at once: {keys:?}");
	assert!(
		keys.iter().any(|key| key.contains("third")),
		"another session's decision is still waiting: {keys:?}"
	);
	assert!(
		keys.iter().any(|key| key.starts_with("request-failed:")),
		"and a refusal is not a decision, so opening a session does not clear it: {keys:?}"
	);
}
