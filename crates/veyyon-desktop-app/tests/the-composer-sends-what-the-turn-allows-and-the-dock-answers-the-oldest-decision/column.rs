//! A window that draws a thread's transcript draws the composer under it, in
//! every state the thread's place reaches.
//!
//! WHY: the transcript and the composer are drawn by the one thread view the
//! workspace puts in the thread's place while a session is shown. A composer
//! gated on anything else (the thread list having arrived, a transcript held,
//! a header received) draws turns with nothing to type into. The sweep reads
//! the expectation off the window's state, a session shown and settings
//! closed, so a fixture that changes shape changes what it demands.
//!
//! Gap: the composer's box is found, not its pixels; a state of the thread's
//! place none of these fixtures reaches is not swept, and a new one must be
//! added to `columns` by hand.

use gpui::{
	AnyView, AppContext as _, EmptyView, Entity, Focusable as _, TestAppContext, VisualTestContext,
	px, size,
};
use veyyon_desktop_app::{
	AppState, driver,
	thread::ThreadView,
	workspace::{Regions, Workspace, WorkspaceLayout},
};
use veyyon_desktop_model::{
	HostAction, HostEvent, PanelsStore, PersistedState, SessionId, SessionStatus, SessionSummary,
	SnapshotSection, Store, Versioned,
};

use super::{WINDOW, install, opened, other, report, sid};

/// A whole window: the workspace with the real thread in the thread's place
/// and every other region empty.
pub struct Desk<'a> {
	pub state:  Entity<AppState>,
	pub thread: Entity<ThreadView>,
	pub cx:     &'a mut VisualTestContext,
}

/// Opens the workspace over `store` fed `events`, with settings in the
/// thread's place when `settings`, and drops the requests the events queued.
pub fn desk(
	app: &mut TestAppContext,
	store: Store,
	events: Vec<HostEvent>,
	settings: bool,
) -> Desk<'_> {
	install(app);
	app.update(|cx| WorkspaceLayout::update(cx, |layout| layout.settings_open = settings));
	let state = app.new(|_| AppState::new(store));
	state.update(app, |state, cx| state.apply(events, cx));
	state.update(app, |state, _| state.drain_outbox());
	let view_state = state.clone();
	let mut built = None;
	let (_, cx) = app.add_window_view(|window, cx| {
		let thread = cx.new(|cx| ThreadView::new(view_state.clone(), window, cx));
		built = Some(thread.clone());
		let mut empty = || AnyView::from(cx.new(|_| EmptyView));
		let regions = Regions {
			sidebar:  empty(),
			thread:   thread.into(),
			panel:    empty(),
			drawer:   empty(),
			palette:  empty(),
			settings: empty(),
		};
		Workspace::new(view_state, regions, PanelsStore::default(), window, cx)
	});
	cx.simulate_resize(size(px(WINDOW.0), px(WINDOW.1)));
	cx.run_until_parked();
	let thread = built.expect("the window built its regions");
	Desk { state, thread, cx }
}

impl Desk<'_> {
	/// Whether a frame drawn now draws the driver target `id`.
	pub fn drawn(&mut self, id: &str) -> bool {
		self.cx.update(|window, _| window.refresh());
		self.cx.run_until_parked();
		self
			.cx
			.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
			.is_some()
	}

	/// Whether the keys are in the composer's editor.
	pub fn keys_in_composer(&mut self) -> bool {
		let editor = self
			.thread
			.read_with(&*self.cx, |thread, cx| thread.composer().read(cx).editor().clone());
		self
			.cx
			.update(|window, cx| editor.focus_handle(cx).is_focused(window))
	}

	/// The composer's draft.
	pub fn draft(&self) -> String {
		self
			.thread
			.read_with(&*self.cx, |thread, cx| thread.composer().read(cx).text(cx).to_owned())
	}

	/// The actions queued since the last drain, without draft reports.
	pub fn sent(&mut self) -> Vec<HostAction> {
		self
			.state
			.update(self.cx, |state, _| state.drain_outbox())
			.into_iter()
			.map(|request| request.action)
			.filter(|action| report(action).is_none())
			.collect()
	}

	/// Whether the window's state puts a thread in the thread's place: a
	/// session shown and settings closed.
	pub fn shows_a_thread(&self) -> bool {
		self.state.read_with(&*self.cx, |state, cx| {
			state.active_session().is_some() && !WorkspaceLayout::get(cx).settings_open
		})
	}
}

/// A state the thread's place reaches, named for what the window shows.
pub struct Column {
	pub name:     &'static str,
	pub store:    Store,
	pub events:   Vec<HostEvent>,
	pub settings: bool,
}

/// The threads the host lists: `s` and `t`.
fn listing() -> HostEvent {
	let summary = |id: SessionId| SessionSummary {
		path: format!("/sessions/{}.jsonl", id.0),
		id,
		workspace: "ws".to_owned(),
		cwd: "/w".to_owned(),
		title: None,
		parent_path: None,
		created_at_ms: 0,
		modified_at_ms: 1,
		message_count: 1,
		size_bytes: 1,
		first_message: None,
		searchable_messages: None,
		status: SessionStatus::Complete,
	};
	HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned { revision: 1, value: vec![summary(sid()), summary(other())] },
		Vec::new(),
	))
}

/// Every state the thread's place reaches.
pub fn columns() -> Vec<Column> {
	let remembered = || {
		let mut persisted = PersistedState::new();
		persisted.shell.active_session = Some(sid());
		Store::with_persisted(persisted)
	};
	let column = |name, store, events, settings| Column { name, store, events, settings };
	vec![
		column("nothing received", Store::new(), Vec::new(), false),
		column("threads listed, none open", Store::new(), vec![listing()], false),
		column("a thread remembered, nothing received", remembered(), Vec::new(), false),
		column("a transcript before the thread list", Store::new(), opened(), false),
		column(
			"a transcript under a listed thread",
			Store::new(),
			[vec![listing()], opened()].concat(),
			false,
		),
		column("settings over an open thread", Store::new(), opened(), true),
	]
}

#[test]
fn the_composer_is_drawn_wherever_the_thread_and_its_transcript_are() {
	let mut shown = Vec::new();
	for Column { name, store, events, settings } in columns() {
		let mut app = TestAppContext::single();
		let mut w = desk(&mut app, store, events, settings);
		let thread = w.shows_a_thread();
		let composer = w.drawn("composer");
		let transcript = w.drawn("transcript");
		assert_eq!(composer, thread, "{name}: the composer is drawn exactly where a thread is");
		assert_eq!(transcript, composer, "{name}: a drawn transcript has a composer under it");
		shown.push(thread);
	}
	assert!(
		shown.contains(&true) && shown.contains(&false),
		"the sweep reaches the thread's place both drawn and not: {shown:?}"
	);
}
