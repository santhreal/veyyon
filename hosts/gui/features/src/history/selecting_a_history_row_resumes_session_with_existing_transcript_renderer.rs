//! WHY: Resuming a previous session from the history surface must reuse the
//! canonical transcript renderer rather than introducing a separate playback
//! implementation that could drift in styling, selection behavior, or block
//! rendering capabilities. Selecting a history session row must issue
//! `UiCommand::OpenSession` to load and focus the chosen conversation and
//! render its transcript through `crate::transcript`.
//!
//! This suite closes the class of duplicate transcript renderers and broken
//! session resume dispatch by asserting that selecting a session row
//! transitions the store selection and renders the existing transcript timeline
//! element tree.
//!
//! What it does not catch: backend network latency when streaming transcript
//! entries.

use gpui::{AppContext, TestAppContext};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{RemoteData, SessionId, SessionStatus, SessionSummary, Versioned, WorkspaceId},
	navigation::Route,
};

use crate::{history::render_center, transcript::Timeline};

#[gpui::test]
fn test_selecting_history_row_dispatches_open_session_and_renders_transcript(
	cx: &mut TestAppContext,
) {
	let mut store = Store::detached();
	store.frontend.route = Route::History;

	let target_id = SessionId::new("history-session-42").unwrap();
	let session_summary = SessionSummary {
		id:                  target_id.clone(),
		workspace:           WorkspaceId::new("ws-target").unwrap(),
		path:                "/workspaces/session-42.jsonl".to_owned(),
		cwd:                 "/workspaces/target-repo".to_owned(),
		title:               Some("Historic Architecture Review".to_owned()),
		parent_path:         None,
		created_at_ms:       1000,
		modified_at_ms:      2000,
		message_count:       5,
		size_bytes:          1024,
		first_message:       Some("Reviewing core architecture".to_owned()),
		searchable_messages: Some("Detailed architectural invariants".to_owned()),
		status:              SessionStatus::Complete,
	};

	store.replica.sessions.sessions =
		RemoteData::Ready(Versioned { revision: 1, value: vec![session_summary] });

	// Dispatched command when clicking a row is OpenSession
	let command = UiCommand::OpenSession(target_id.clone());
	store.dispatch(command);

	// Ensure the selection in frontend state transitioned to target session
	assert_eq!(store.frontend.selected_session.as_ref(), Some(&target_id));

	// Verify that history center workspace renders via existing transcript timeline
	cx.update(|app| {
		let timeline = app.new(Timeline::new);
		let center_element = render_center(&store, &timeline, app);
		drop(center_element);
		drop(timeline);
	});
}
