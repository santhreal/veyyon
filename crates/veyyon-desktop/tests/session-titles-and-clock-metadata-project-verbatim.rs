//! WHY: session titles and queue row metadata must preserve user text verbatim
//! across special characters, slashes, unicode, and whitespace without unwanted
//! mutation or lost state, and clock ticks must update only elapsed labels.
//!
//! CLASS CLOSED: session title sanitization or truncation bugs that strip path
//! separators or unicode characters; missing or whitespace-only titles failing
//! to default to the canonical "new session" label; clock ticks modifying
//! non-clock shell state or causing unnecessary re-renders.
//!
//! NOT CAUGHT: live host file-system session loading; terminal emulator clock
//! ticks. Intent-to-action dispatch is in
//! `an-intent-maps-to-the-actions-the-host-answers.rs`.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, session};
use veyyon_desktop::{SessionIndex, project, project_clock};
use veyyon_desktop_model::{
	ApprovalInteraction, HostEvent, InteractionId, PendingDecisions, PlanInteraction,
	QuestionInteraction, QueuePartition, SessionId, SessionStatus, SessionSummary, SnapshotSection,
	Store, Versioned, reduce,
};
use veyyon_desktop_surface::{Card, ShellState};

fn store_with_decisions() -> (Store, SessionIndex) {
	let mut store = Store::new();
	let mut row = session("s", QueuePartition::Live, None);
	row.last_recall_at_ms = NOW_MS;
	store.sessions.insert(row);
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
fn session_titles_preserve_verbatim_text_and_default_absent_to_new_session() {
	let mut store = Store::new();
	let snapshot = SnapshotSection::Sessions(
		Versioned {
			revision: 1,
			value:    vec![
				SessionSummary {
					id:                  "s1".into(),
					workspace:           "ws".into(),
					path:                "/home/user/.veyyon/sessions/s1.jsonl".into(),
					cwd:                 "/repo".into(),
					title:               Some("Review lib/network.rs".into()),
					parent_path:         None,
					created_at_ms:       NOW_MS,
					modified_at_ms:      NOW_MS,
					message_count:       2,
					size_bytes:          100,
					first_message:       None,
					searchable_messages: None,
					status:              SessionStatus::Complete,
				},
				SessionSummary {
					id:                  "s2".into(),
					workspace:           "ws".into(),
					path:                "/home/user/.veyyon/sessions/s2.jsonl".into(),
					cwd:                 "/repo".into(),
					title:               Some("Update package.json".into()),
					parent_path:         None,
					created_at_ms:       NOW_MS,
					modified_at_ms:      NOW_MS,
					message_count:       1,
					size_bytes:          50,
					first_message:       None,
					searchable_messages: None,
					status:              SessionStatus::Complete,
				},
				SessionSummary {
					id:                  "s3".into(),
					workspace:           "ws".into(),
					path:                "/home/user/.veyyon/sessions/s3.jsonl".into(),
					cwd:                 "/repo".into(),
					title:               Some("🚀 Deploy 修正".into()),
					parent_path:         None,
					created_at_ms:       NOW_MS,
					modified_at_ms:      NOW_MS,
					message_count:       1,
					size_bytes:          50,
					first_message:       None,
					searchable_messages: None,
					status:              SessionStatus::Complete,
				},
				SessionSummary {
					id:                  "s4".into(),
					workspace:           "ws".into(),
					path:                "/home/user/.veyyon/sessions/s4.jsonl".into(),
					cwd:                 "/repo".into(),
					title:               None,
					parent_path:         None,
					created_at_ms:       NOW_MS,
					modified_at_ms:      NOW_MS,
					message_count:       0,
					size_bytes:          0,
					first_message:       None,
					searchable_messages: None,
					status:              SessionStatus::Complete,
				},
				SessionSummary {
					id:                  "s5".into(),
					workspace:           "ws".into(),
					path:                "/home/user/.veyyon/sessions/s5.jsonl".into(),
					cwd:                 "/repo".into(),
					title:               Some("   ".into()),
					parent_path:         None,
					created_at_ms:       NOW_MS,
					modified_at_ms:      NOW_MS,
					message_count:       0,
					size_bytes:          0,
					first_message:       None,
					searchable_messages: None,
					status:              SessionStatus::Complete,
				},
			],
		},
		Vec::new(),
	);

	reduce(&mut store, HostEvent::Snapshot(snapshot));

	assert_eq!(
		store.sessions.get(&SessionId::from("s1")).unwrap().title,
		"Review lib/network.rs",
		"titles with slashes preserved verbatim"
	);
	assert_eq!(
		store.sessions.get(&SessionId::from("s2")).unwrap().title,
		"Update package.json",
		"titles with .json preserved verbatim"
	);
	assert_eq!(
		store.sessions.get(&SessionId::from("s3")).unwrap().title,
		"🚀 Deploy 修正",
		"unicode titles preserved verbatim"
	);
	assert_eq!(
		store.sessions.get(&SessionId::from("s4")).unwrap().title,
		"new session",
		"absent title defaults to neutral new session label"
	);
	assert_eq!(
		store.sessions.get(&SessionId::from("s5")).unwrap().title,
		"new session",
		"whitespace title defaults to neutral new session label"
	);

	let mut index = SessionIndex::new();
	let mut state = ShellState::default();
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);

	let titles: Vec<String> = state
		.sections
		.iter()
		.flat_map(|(_, rows)| rows.iter().map(|r| r.title.clone()))
		.collect();
	assert_eq!(titles, vec![
		"Review lib/network.rs",
		"Update package.json",
		"🚀 Deploy 修正",
		"new session",
		"new session"
	]);
}

#[test]
fn project_clock_updates_only_elapsed_metadata_and_reports_changes() {
	let (store, mut index) = store_with_decisions();
	let mut state = ShellState::default();
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);

	assert_eq!(state.sections.len(), 1);
	let initial_meta = state.sections[0].1[0].meta.clone();
	assert_eq!(initial_meta, Some("0s".into()));

	// Same second tick: no change
	let changed_same = project_clock(&store, &index, NOW_MS + 200, &mut state);
	assert!(!changed_same, "sub-second change does not alter label");
	assert_eq!(state.sections[0].1[0].meta, Some("0s".into()));

	// 5 seconds tick: label updates to 5s, returns true
	let changed_tick = project_clock(&store, &index, NOW_MS + 5_000, &mut state);
	assert!(changed_tick, "second tick updates label and returns true");
	assert_eq!(state.sections[0].1[0].meta, Some("5s".into()));

	// 65 seconds tick: label updates to 1m
	let changed_minute = project_clock(&store, &index, NOW_MS + 65_000, &mut state);
	assert!(changed_minute);
	assert_eq!(state.sections[0].1[0].meta, Some("1m".into()));
}
