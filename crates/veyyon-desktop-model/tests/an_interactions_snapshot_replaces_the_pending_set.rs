//! WHY THIS SUITE EXISTS
//!
//! `Store::interactions` had no writer: the cards were projected from it and
//! answered into it, and nothing the host sent ever filled it. A tool waiting
//! on approval blocked forever with no card on screen.
//!
//! THE CLASS THIS CLOSES: a host-owned domain the reducer never fills, and a
//! snapshot that merges when it should replace. Each `Interactions` section is
//! the whole pending set for one session: a card the host no longer lists is
//! taken down, and the damage names both the cards that were and the cards
//! that are, so an answered card is repainted away.
//!
//! WHAT IT DOES NOT CATCH: the host sending a stale set, and a desktop that
//! answers a card the host already settled. The `RequestFailed` route covers
//! the second; nothing here covers the first.

use veyyon_desktop_model::{
	ApprovalInteraction, Damage, HostEvent, InteractionId, PendingDecisions, PlanInteraction,
	QuestionInteraction, SessionId, SnapshotSection, Store, reduce,
};

fn approval(id: &str) -> ApprovalInteraction {
	ApprovalInteraction {
		id:              InteractionId::from(id),
		tool_name:       "bash".to_string(),
		detail:          "rm -rf build".to_string(),
		requested_at_ms: 1,
	}
}

fn section(session: &str, pending: PendingDecisions) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Interactions { session: SessionId::from(session), pending })
}

#[test]
fn a_section_replaces_the_session_s_pending_set_and_damages_every_card_it_touched() {
	let mut store = Store::new();
	let first = reduce(
		&mut store,
		section("s", PendingDecisions {
			approvals: vec![approval("a-1")],
			questions: vec![QuestionInteraction {
				id:              InteractionId::from("q-1"),
				prompt:          "Which?".to_string(),
				options:         vec!["x".to_string()],
				requested_at_ms: 1,
			}],
			plans:     Vec::new(),
		}),
	);
	assert!(
		first.contains(&Damage::PendingDecision(SessionId::from("s"), InteractionId::from("a-1")))
	);
	assert!(
		first.contains(&Damage::PendingDecision(SessionId::from("s"), InteractionId::from("q-1")))
	);
	assert!(first.contains(&Damage::Composer(SessionId::from("s"))));

	// The question was answered; the host now lists the approval and a plan.
	let second = reduce(
		&mut store,
		section("s", PendingDecisions {
			approvals: vec![approval("a-1")],
			questions: Vec::new(),
			plans:     vec![PlanInteraction {
				id:              InteractionId::from("p-1"),
				markdown_plan:   "# Plan".to_string(),
				requested_at_ms: 2,
			}],
		}),
	);
	let pending = &store.interactions[&SessionId::from("s")];
	assert_eq!(pending.approvals.len(), 1);
	assert!(pending.questions.is_empty(), "a snapshot replaces; the answered question is gone");
	assert_eq!(pending.plans.len(), 1);
	assert!(
		second.contains(&Damage::PendingDecision(SessionId::from("s"), InteractionId::from("q-1"))),
		"the card taken down is damaged, or it stays painted"
	);
	assert!(
		second.contains(&Damage::PendingDecision(SessionId::from("s"), InteractionId::from("p-1")))
	);
}

#[test]
fn an_empty_section_clears_the_session_and_leaves_other_sessions_alone() {
	let mut store = Store::new();
	reduce(
		&mut store,
		section("s", PendingDecisions {
			approvals: vec![approval("a-1")],
			questions: Vec::new(),
			plans:     Vec::new(),
		}),
	);
	reduce(
		&mut store,
		section("t", PendingDecisions {
			approvals: vec![approval("a-2")],
			questions: Vec::new(),
			plans:     Vec::new(),
		}),
	);

	let damage = reduce(&mut store, section("s", PendingDecisions::new()));

	assert!(!store.interactions.contains_key(&SessionId::from("s")));
	assert_eq!(
		store.interactions[&SessionId::from("t")].approvals[0].id,
		InteractionId::from("a-2")
	);
	assert!(
		damage.contains(&Damage::PendingDecision(SessionId::from("s"), InteractionId::from("a-1")))
	);
	assert!(
		!damage.contains(&Damage::PendingDecision(SessionId::from("t"), InteractionId::from("a-2")))
	);
}

#[test]
fn the_section_decodes_from_the_frame_the_host_writes() {
	// The exact bytes `InteractionLedger.#publish` in
	// `packages/coding-agent/src/gui-host/interactions.ts` writes.
	let frame = r#"{"Snapshot":{"Interactions":{"session":"abc","pending":{"approvals":[{"id":"approval-1","tool_name":"bash","detail":"**Scope:** This call only","requested_at_ms":5}],"questions":[{"id":"question-2","prompt":"Name it","options":[],"requested_at_ms":6}],"plans":[]}}}}"#;
	let event: HostEvent = serde_json::from_str(frame).expect("the host's frame decodes");
	let HostEvent::Snapshot(SnapshotSection::Interactions { session, pending }) = event else {
		panic!("decoded as the wrong variant");
	};
	assert_eq!(session, SessionId::from("abc"));
	assert_eq!(pending.approvals[0].tool_name, "bash");
	assert_eq!(pending.questions[0].options, Vec::<String>::new());
}
