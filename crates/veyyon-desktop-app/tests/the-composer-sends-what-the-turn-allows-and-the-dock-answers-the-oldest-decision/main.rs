//! The composer sends what the session's turn allows and grows with its
//! draft; the dock above it answers the oldest decision the session waits on.
//!
//! WHY: the composer and the dock are embedded in the thread cached, laid out
//! at the height they last drew at. A seed that differs from the height the
//! empty composer draws at makes the first frame pop; a height the thread
//! does not follow clips a growing draft. A primary control that reads the
//! wrong phase of the turn sends a prompt where a steer was meant, and a
//! stray Enter that answers an approval runs a tool that was never
//! approved. A dock that waits for the host before showing the next decision
//! stalls the keyboard, and one that drops a refused answer loses the
//! decision. A draft report sent per repaint floods the host, and one skipped
//! on a caret move leaves an extension reading a stale caret. A region
//! notified per streamed delta or per keystroke elsewhere renders for
//! nothing. The thread header's freeze control, the session mode and the
//! goal the dock pins are driven from the same window. A draft, its queue
//! mode and its attachments are left in a session and found there again,
//! the footer states the model, level and context the host reported, and a
//! key reaches no more than the control it stands for. The verbs the terminal
//! binds a key to (copying the draft, stepping or holding a model, editing
//! the draft in an external editor) have a key here too. The suite drives the
//! real `ThreadView` over an `AppState` fed host events and reads the
//! requests, the text and the geometry it drew; `column` and `gates` open
//! the whole workspace with that thread in the thread's place.
//!
//! Gap: pointer clicks on the card and goal buttons are not driven; the keys
//! and the actions they bind to are. Dictation is not driven here, and a file
//! is attached through the file picker or a saved draft, never a drop.

mod branch;
mod column;
mod composer;
mod dock;
mod drafts;
#[cfg(unix)]
mod editor;
mod footer;
mod freeze;
mod gates;
mod goal;
mod mode;
mod paste;
mod phase;
mod queue;
mod verbs;

use std::path::PathBuf;

use gpui::{
	AppContext as _, Bounds, Entity, Focusable as _, Modifiers, Pixels, TestAppContext,
	VisualTestContext, px, size,
};
use veyyon_desktop_app::{
	AppState, composer::Composer, dock::InteractionDock, driver, keymap, thread::ThreadView,
};
use veyyon_desktop_model::{
	BackendError, Capability, CapabilityStatus, ComposerRequest, ComposerStore, ContentBlock,
	EntryId, ErrorScope, HostAction, HostEvent, HostRequest, MessageRole, PendingDecisions,
	RequestId, SessionHeaderView, SessionId, SnapshotSection, Store, StreamingMessageState,
	TranscriptEntry, Versioned,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// The window every test draws in.
pub const WINDOW: (f32, f32) = (1600.0, 1000.0);

pub struct Win<'a> {
	pub state:    Entity<AppState>,
	pub composer: Entity<Composer>,
	pub dock:     Entity<InteractionDock>,
	pub cx:       &'a mut VisualTestContext,
}

/// Installs the theme, the actions and the keymap, with reduced motion on.
pub fn install(app: &mut TestAppContext) {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
		keymap::install(cx).expect("the default keymap parses");
		cx.set_reduce_motion(true);
	});
}

/// Opens the thread of session `s` over a store fed `events`, reduced motion
/// on, and drops the requests the events queued.
pub fn window(app: &mut TestAppContext, events: Vec<HostEvent>) -> Win<'_> {
	install(app);
	reopen(app, Store::new(), events)
}

/// Opens the thread of session `s` in another window of an app `window` set
/// up, over `store` fed `events`: a window reopened over what an earlier one
/// persisted.
pub fn reopen(app: &mut TestAppContext, store: Store, events: Vec<HostEvent>) -> Win<'_> {
	let state = app.new(|_| AppState::new(store));
	state.update(app, |state, cx| state.apply(opened(), cx));
	state.update(app, |state, cx| state.apply(events, cx));
	state.update(app, |state, _| state.drain_outbox());
	let view_state = state.clone();
	let (thread, cx) = app.add_window_view(|window, cx| ThreadView::new(view_state, window, cx));
	cx.simulate_resize(size(px(WINDOW.0), px(WINDOW.1)));
	cx.run_until_parked();
	let (composer, dock) =
		thread.read_with(cx, |thread, _| (thread.composer().clone(), thread.dock().clone()));
	Win { state, composer, dock, cx }
}

impl Win<'_> {
	/// Every request queued since the last drain.
	pub fn drain(&mut self) -> Vec<HostRequest> {
		self.state.update(self.cx, |state, _| state.drain_outbox())
	}

	/// The requests queued since the last drain, without the draft reports
	/// the composer sends each time the draft or its caret moves.
	pub fn requests(&mut self) -> Vec<HostRequest> {
		let mut requests = self.drain();
		requests.retain(|request| report(&request.action).is_none());
		requests
	}

	/// The actions queued since the last drain.
	pub fn sent(&mut self) -> Vec<HostAction> {
		self
			.requests()
			.into_iter()
			.map(|request| request.action)
			.collect()
	}

	pub fn apply(&mut self, events: Vec<HostEvent>) {
		self
			.state
			.update(self.cx, |state, cx| state.apply(events, cx));
		self.cx.run_until_parked();
	}

	pub fn dispatch(&mut self, action: impl gpui::Action) {
		self.cx.dispatch_action(action);
		self.cx.run_until_parked();
	}

	/// Presses `keys`, space-separated as gpui spells them.
	pub fn keys(&mut self, keys: &str) {
		self.cx.simulate_keystrokes(keys);
		self.cx.run_until_parked();
	}

	/// Clicks the middle of the driver target `id`.
	pub fn click(&mut self, id: &str) {
		let at = self
			.bounds(id)
			.unwrap_or_else(|| panic!("{id} is laid out"))
			.center();
		self.cx.simulate_click(at, Modifiers::none());
		self.cx.run_until_parked();
	}

	/// Replaces the draft with `text`, as a palette row or an extension does.
	pub fn write(&mut self, text: &str) {
		self.dispatch(veyyon_desktop_app::actions::composer::InsertText { text: text.to_owned() });
	}

	/// Puts the keys in the composer's editor.
	pub fn focus(&mut self) {
		let editor = self
			.composer
			.read_with(&*self.cx, |composer, _| composer.editor().clone());
		self.cx.update(|window, cx| {
			let focus = editor.focus_handle(cx);
			window.focus(&focus, cx);
		});
		self.cx.run_until_parked();
	}

	/// Focuses the composer's editor and types `text` into it.
	pub fn typed(&mut self, text: &str) {
		self.focus();
		self.cx.simulate_input(text);
		self.cx.run_until_parked();
	}

	pub fn draft(&self) -> String {
		self
			.composer
			.read_with(&*self.cx, |composer, cx| composer.text(cx).to_owned())
	}

	/// Shows `session` in the window, as a click on its row does.
	pub fn show(&mut self, session: SessionId) {
		self.state.update(self.cx, |state, cx| {
			state.open_session(session, cx);
		});
		self.cx.run_until_parked();
	}

	/// The draft saved for `session`.
	pub fn saved(&self, session: &SessionId) -> Option<ComposerStore> {
		self
			.state
			.read_with(&*self.cx, |state, _| state.draft(session).cloned())
	}

	/// The name and bytes of each attachment in the tray, in order.
	pub fn tray(&self) -> Vec<(String, Vec<u8>)> {
		self.composer.read_with(&*self.cx, |composer, _| {
			composer
				.attachments()
				.iter()
				.map(|attachment| (attachment.name.clone(), attachment.bytes.to_vec()))
				.collect()
		})
	}

	/// Attaches the files at `paths` through the file picker.
	pub fn attach(&mut self, paths: Vec<PathBuf>) {
		self.dispatch(veyyon_desktop_app::actions::composer::AttachFiles);
		self.cx.simulate_path_prompt_response(move |_| Some(paths));
		self.cx.run_until_parked();
	}

	/// The height the thread lays the composer out at.
	pub fn composer_height(&self) -> Pixels {
		self
			.composer
			.read_with(&*self.cx, |composer, _| composer.height())
	}

	pub fn bounds(&mut self, id: &str) -> Option<Bounds<Pixels>> {
		self
			.cx
			.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
	}

	pub fn drew(&mut self, text: &str) -> bool {
		self.count(text) > 0
	}

	/// How many text runs of the last frame read `text`.
	pub fn count(&mut self, text: &str) -> usize {
		self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.filter(|run| run.text.as_ref() == text)
				.count()
		})
	}

	/// How many times the composer and the dock have rendered.
	pub fn renders(&self) -> (usize, usize) {
		let composer = self
			.composer
			.read_with(&*self.cx, |composer, _| composer.render_count());
		let dock = self
			.dock
			.read_with(&*self.cx, |dock, _| dock.render_count());
		(composer, dock)
	}
}

pub fn sid() -> SessionId {
	SessionId::from("s")
}

/// The other session the tests switch to.
pub fn other() -> SessionId {
	SessionId::from("t")
}

/// The draft and caret a draft report states, or `None` for another action.
pub fn report(action: &HostAction) -> Option<(String, u32)> {
	match action {
		HostAction::Composer(ComposerRequest::ReportComposerDraft { text, cursor, .. }) => {
			Some((text.clone(), *cursor))
		},
		_ => None,
	}
}

/// A transcript entry reading `text`.
pub fn entry(id: &str, role: MessageRole, text: &str, revision: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: None,
		revision,
		timestamp_ms: revision,
		role,
		content: vec![ContentBlock::Text { text: text.to_owned() }],
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

/// The header of session `s` at `revision`, in the mode the host names
/// `mode`.
pub fn header(mode: Option<&str>, revision: u64) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
		revision,
		value: SessionHeaderView {
			id:             sid(),
			schema_version: 1,
			title:          None,
			title_source:   None,
			parent:         None,
			created_at_ms:  0,
			cwd:            "/w/s".to_owned(),
			mode:           mode.map(str::to_owned),
		},
	}))
}

/// The host granting `capability`, or withholding it for `reason`.
pub fn capability(capability: Capability, reason: Option<&str>) -> HostEvent {
	let status = reason.map_or(CapabilityStatus::Available, |reason| {
		CapabilityStatus::Unavailable { reason: reason.to_owned() }
	});
	HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(capability, status)]))
}

/// Session `s` open with its first prompt.
pub fn opened() -> Vec<HostEvent> {
	vec![
		header(None, 1),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    vec![entry("s-0", MessageRole::User, "Index the repo.", 1)],
		})),
	]
}

/// The reply to session `s` streamed so far, at `revision`.
pub fn streamed(revision: u64) -> HostEvent {
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry: EntryId::from("stream-1"),
		tool: None,
		accumulating: entry("stream-1", MessageRole::Assistant, "Indexing the repo", revision),
		revision,
	}))
}

/// The decisions session `s` waits on.
pub fn waiting(pending: PendingDecisions) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Interactions { session: sid(), pending })
}

/// The host refusing `request`.
pub fn refused(request: RequestId) -> HostEvent {
	HostEvent::RequestFailed {
		request,
		error: BackendError {
			scope:          ErrorScope::Session,
			code:           None,
			message:        "the host is busy".to_owned(),
			retryable:      true,
			request:        Some(request),
			occurred_at_ms: 0,
		},
	}
}
