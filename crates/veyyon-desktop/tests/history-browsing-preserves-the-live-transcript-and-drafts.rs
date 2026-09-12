//! WHY: history must not become the active session until an explicit resume.
//! Preview and resume retain the host's opaque session ID, not its storage
//! path. Covers production reducer/projection/actions, host-ranked content
//! results and request-specific errors and deadlines. Does not prove native
//! pixels or host disk loading.

use veyyon_desktop::{
	SessionIndex, actions_for,
	project::{HistoryRequests, project_history},
};
use veyyon_desktop_model::{
	BackendError, ComposerStore, ContentBlock, ErrorScope, HostAction, HostActionKind, HostEvent,
	MessageRole, RequestId, RequestRegistry, SessionId, SessionSearchView, SessionStatus,
	SessionSummary, SessionTranscriptView, SnapshotSection, Store, SurfaceId, TranscriptEntry,
	TranscriptTree, Versioned, reduce,
};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteItemKind, PaletteState, ShellState, history::HistoryState,
};

fn summary(id: &str, cwd: &str, modified: u64) -> SessionSummary {
	SessionSummary {
		id:                  id.into(),
		workspace:           cwd.into(),
		path:                format!("/sessions/{modified}/capture.jsonl"),
		cwd:                 cwd.into(),
		title:               Some(format!("Conversation in {cwd}")),
		parent_path:         None,
		created_at_ms:       modified,
		modified_at_ms:      modified,
		message_count:       1,
		size_bytes:          10,
		first_message:       Some("Opening prompt".into()),
		searchable_messages: None,
		status:              SessionStatus::Complete,
	}
}

#[test]
fn host_content_results_are_grouped_by_day_and_repository_and_open_only_a_preview() {
	let mut store = Store::new();
	let mut state = ShellState {
		overlay: Some(Overlay::Palette(PaletteState::history("buried content".into()))),
		..ShellState::default()
	};
	let sessions = vec![
		summary("archive-z", "/repo/z", 172_800_100),
		summary("archive-b", "/repo/b", 86_400_000),
		summary("archive-a", "/repo/a", 172_800_000),
	];
	let identities: Vec<_> = sessions
		.iter()
		.map(|session| (session.title.clone().unwrap(), session.id.clone()))
		.collect();
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::SessionSearch(SessionSearchView {
			query: "buried content".into(),
			sessions,
		})),
	);
	project_history(&store, &mut state, 172_801_000);
	let palette = state.overlay_palette().unwrap();
	let rows = palette.filtered_items();
	assert_eq!(
		rows
			.iter()
			.map(|row| row.title.as_str())
			.collect::<Vec<_>>(),
		vec!["Conversation in /repo/a", "Conversation in /repo/z", "Conversation in /repo/b"]
	);
	assert_eq!(
		rows
			.iter()
			.map(|row| row.group.as_deref().unwrap())
			.collect::<Vec<_>>(),
		vec!["Today (UTC) · /repo/a", "Today (UTC) · /repo/z", "Yesterday (UTC) · /repo/b"]
	);
	let intent = palette.run_intent().unwrap();
	assert_eq!(intent, Intent::PreviewSession("archive-a".into()));
	for row in rows {
		let (_, session) = identities
			.iter()
			.find(|(title, _)| title == &row.title)
			.unwrap();
		let PaletteItemKind::Command { intent } = &row.kind else {
			panic!("history result must open a preview")
		};
		let Intent::PreviewSession(target) = intent.as_ref() else {
			panic!("history result must not activate the session")
		};
		assert_eq!(target, &session.0);
		assert_eq!(actions_for(intent, &SessionIndex::new(), &mut store), vec![
			HostAction::PreviewSessionTranscript { session: session.clone() }
		]);
		assert_eq!(
			actions_for(&Intent::ResumeHistory(target.clone()), &SessionIndex::new(), &mut store),
			vec![HostAction::OpenSession { session: session.clone() }, HostAction::RefreshChanges]
		);
	}
	assert_eq!(store.persisted.shell.active_session, None);
	state.overlay = Some(Overlay::Palette(PaletteState::history("new query".into())));
	project_history(&store, &mut state, 172_801_000);
	assert!(state.overlay_palette().unwrap().filtered_items().is_empty());
}

#[test]
fn keyed_preview_does_not_replace_live_state_and_resume_is_explicit() {
	let mut store = Store::new();
	let live = SessionId::from("live");
	store.persisted.shell.active_session = Some(live.clone());
	store
		.persisted
		.composer
		.insert(live.clone(), ComposerStore {
			draft_text: "unfinished live prompt".into(),
			..ComposerStore::default()
		});
	store
		.transcripts
		.insert(live.clone(), TranscriptTree::new());
	let before = store.persisted.clone();
	let transcripts = store.transcripts.clone();
	let entry = TranscriptEntry {
		id:                "history-entry".into(),
		parent:            None,
		revision:          3,
		timestamp_ms:      1,
		role:              MessageRole::User,
		content:           vec![ContentBlock::Text { text: "historical prompt".into() }],
		meta:              None,
		raw_discriminator: "message".into(),
		raw:               serde_json::json!({}),
	};
	let mut state = ShellState {
		overlay: Some(Overlay::History(Box::new(HistoryState::loading("history".into())))),
		..ShellState::default()
	};
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::SessionTranscript(SessionTranscriptView {
			session:    "history".into(),
			transcript: Versioned { revision: 3, value: vec![entry] },
		})),
	);
	project_history(&store, &mut state, 10);
	assert_eq!(store.persisted, before);
	assert_eq!(store.transcripts, transcripts);
	assert!(state.transcript.is_empty());
	let Some(Overlay::History(preview)) = state.overlay else {
		panic!("preview closed")
	};
	assert!(!preview.loading);
	assert_eq!(preview.turns.len(), 1);
	assert_eq!(
		actions_for(&Intent::ResumeHistory("history".into()), &SessionIndex::new(), &mut store),
		vec![HostAction::OpenSession { session: "history".into() }, HostAction::RefreshChanges]
	);
	assert_eq!(store.persisted.composer.get(&live).unwrap().draft_text, "unfinished live prompt");
}

#[test]
fn only_the_latest_history_request_can_replace_its_loading_state_with_an_error() {
	let mut requests = HistoryRequests::default();
	let mut state = ShellState {
		overlay: Some(Overlay::Palette(PaletteState::history("new".into()))),
		..ShellState::default()
	};
	requests.sent(RequestId(1), &HostAction::SearchSessions { query: "old".into() });
	requests.sent(RequestId(2), &HostAction::SearchSessions { query: "new".into() });
	let mut error = BackendError {
		scope:          ErrorScope::Session,
		code:           Some("SEARCH_SESSIONS_FAILED".into()),
		message:        "Directory is unreadable".into(),
		retryable:      false,
		request:        Some(RequestId(1)),
		occurred_at_ms: 0,
	};
	assert!(!requests.land_failure(&error, &mut state));
	assert_eq!(state.overlay_palette().unwrap().notice, None);
	error.request = Some(RequestId(2));
	assert!(requests.land_failure(&error, &mut state));
	assert_eq!(state.overlay_palette().unwrap().notice.as_deref(), Some("Directory is unreadable"));
	state.overlay = Some(Overlay::History(Box::new(HistoryState::loading("history".into()))));
	requests.sent(RequestId(3), &HostAction::PreviewSessionTranscript { session: "history".into() });
	error.request = Some(RequestId(3));
	assert!(requests.land_failure(&error, &mut state));
	let Some(Overlay::History(preview)) = state.overlay else {
		panic!("preview closed")
	};
	assert!(!preview.loading);
	assert_eq!(preview.error.as_deref(), Some("Directory is unreadable"));
}

fn pending_history(preview: bool) -> (HistoryRequests, RequestRegistry, ShellState) {
	let mut requests = HistoryRequests::default();
	let mut registry = RequestRegistry::new();
	let (action, kind, overlay) = if preview {
		(
			HostAction::PreviewSessionTranscript { session: "history".into() },
			HostActionKind::PreviewSessionTranscript,
			Overlay::History(Box::new(HistoryState::loading("history".into()))),
		)
	} else {
		(
			HostAction::SearchSessions { query: "history".into() },
			HostActionKind::SearchSessions,
			Overlay::Palette(PaletteState::history("history".into())),
		)
	};
	requests.sent(RequestId(10), &action);
	registry.register(RequestId(10), kind, SurfaceId::GlobalTitlebarLine, 100, 50);
	(requests, registry, ShellState { overlay: Some(overlay), ..ShellState::default() })
}

#[test]
fn history_deadlines_match_the_registry_boundary_and_block_late_results_until_retry() {
	for preview in [false, true] {
		let (mut requests, mut registry, mut state) = pending_history(preview);
		assert!(!requests.expire(99, &mut registry, &mut state));
		assert!(!requests.expire(150, &mut registry, &mut state));
		assert!(registry.get(&RequestId(10)).is_some());
		assert!(requests.expire(151, &mut registry, &mut state));
		assert!(registry.get(&RequestId(10)).is_none());
		assert!(!requests.expire(152, &mut registry, &mut state));
		let mut store = Store::new();
		reduce(
			&mut store,
			HostEvent::Snapshot(SnapshotSection::SessionSearch(SessionSearchView {
				query:    "history".into(),
				sessions: vec![summary("history", "/repo", 100)],
			})),
		);
		reduce(
			&mut store,
			HostEvent::Snapshot(SnapshotSection::SessionTranscript(SessionTranscriptView {
				session:    "history".into(),
				transcript: Versioned { revision: 1, value: vec![] },
			})),
		);
		project_history(&store, &mut state, 152);
		match &state.overlay {
			Some(Overlay::History(history)) => {
				assert!(!history.loading);
				assert!(history.error.as_deref().unwrap().contains("timed out"));
				assert_eq!(history.revision, None);
			},
			Some(Overlay::Palette(palette)) => {
				assert!(palette.notice.as_deref().unwrap().contains("timed out"));
				assert!(palette.filtered_items().is_empty());
			},
			_ => panic!("history overlay closed"),
		}
		// Retrying creates a fresh loading overlay and permits the next response.
		state = pending_history(preview).2;
		project_history(&store, &mut state, 153);
		match &state.overlay {
			Some(Overlay::History(history)) => {
				assert!(!history.loading);
				assert_eq!(history.error, None);
				assert_eq!(history.revision, Some(1));
			},
			Some(Overlay::Palette(palette)) => {
				assert_eq!(palette.notice, None);
				assert_eq!(palette.filtered_items().len(), 1);
			},
			_ => panic!("history overlay closed"),
		}
	}
}

#[test]
fn completed_history_requests_and_superseded_terminal_events_do_not_time_out() {
	for preview in [false, true] {
		let (mut requests, mut registry, mut state) = pending_history(preview);
		requests.finished(RequestId(9));
		assert!(requests.expire(151, &mut registry, &mut state));
		let (mut requests, mut registry, mut state) = pending_history(preview);
		registry.complete(&RequestId(10));
		requests.finished(RequestId(10));
		assert!(!requests.expire(u64::MAX, &mut registry, &mut state));
		let (mut requests, mut registry, mut state) = pending_history(preview);
		registry.prune_stale(151);
		assert!(requests.expire(151, &mut registry, &mut state));
	}
}

#[test]
fn closed_or_retargeted_history_is_not_replaced_by_an_expired_request() {
	for preview in [false, true] {
		for closed in [false, true] {
			let (mut requests, mut registry, mut state) = pending_history(preview);
			state.overlay = if closed {
				None
			} else if preview {
				Some(Overlay::History(Box::new(HistoryState::loading("different".into()))))
			} else {
				Some(Overlay::Palette(PaletteState::history("different".into())))
			};
			assert!(!requests.expire(151, &mut registry, &mut state));
			assert!(registry.get(&RequestId(10)).is_none());
			match &state.overlay {
				Some(Overlay::History(history)) => {
					assert!(history.loading);
					assert_eq!(history.error, None);
				},
				Some(Overlay::Palette(palette)) => assert_eq!(palette.notice, None),
				None => {},
				_ => panic!("history changed overlay type"),
			}
			state = pending_history(preview).2;
			assert!(!requests.expire(152, &mut registry, &mut state));
		}
	}
}
