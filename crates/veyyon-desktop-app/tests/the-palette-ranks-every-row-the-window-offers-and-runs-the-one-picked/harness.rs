//! A window whose workspace lays out the real palette and settings over a
//! store fed host events, every other region empty or, for
//! [`whole_window`], real.

use gpui::{
	AnyView, AppContext as _, Bounds, EmptyView, Entity, Modifiers, Pixels, Point, TestAppContext,
	VisualTestContext, px, size,
};
use veyyon_desktop_app::{
	AppState, driver,
	drawer::TerminalDrawer,
	keymap,
	palette::{CommandPalette, Item},
	panel::RightPanel,
	settings::SettingsView,
	sidebar::Sidebar,
	thread::ThreadView,
	workspace::{Regions, Workspace, WorkspaceLayout},
};
use veyyon_desktop_model::{
	EntryId, HostAction, HostEvent, MessageRole, PanelsStore, SessionHeaderView, SessionId,
	SessionStatus, SessionSummary, SnapshotSection, Store, StreamingMessageState, TranscriptEntry,
	Versioned,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// The window every test draws in.
pub const WINDOW: (f32, f32) = (1200.0, 800.0);

pub struct Win<'a> {
	pub state:    Entity<AppState>,
	pub palette:  Entity<CommandPalette>,
	pub settings: Entity<SettingsView>,
	pub cx:       &'a mut VisualTestContext,
}

/// Opens the window over a store fed `events`, with reduced motion on or off,
/// and drops the requests the events queued.
pub fn window(app: &mut TestAppContext, events: Vec<HostEvent>, reduce_motion: bool) -> Win<'_> {
	open_window(app, events, reduce_motion, false)
}

/// Opens the window with the sidebar, thread, panel and drawer real as well,
/// so a window action a palette row dispatches reaches the region that
/// answers it, and drops the requests the events and the regions queued.
pub fn whole_window(app: &mut TestAppContext, events: Vec<HostEvent>) -> Win<'_> {
	open_window(app, events, true, true)
}

fn open_window(
	app: &mut TestAppContext,
	events: Vec<HostEvent>,
	reduce_motion: bool,
	whole: bool,
) -> Win<'_> {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
		keymap::install(cx).expect("the default keymap parses");
		cx.set_reduce_motion(reduce_motion);
	});
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(events, cx));
	state.update(app, |state, _| state.drain_outbox());
	let view_state = state.clone();
	let mut built = None;
	let (_, cx) = app.add_window_view(|window, cx| {
		let palette = cx.new(|cx| CommandPalette::new(view_state.clone(), window, cx));
		let settings = cx.new(|cx| SettingsView::new(view_state.clone(), window, cx));
		built = Some((palette.clone(), settings.clone()));
		let shared = &view_state;
		let regions = if whole {
			Regions {
				sidebar:  cx.new(|cx| Sidebar::new(shared.clone(), window, cx)).into(),
				thread:   cx.new(|cx| ThreadView::new(shared.clone(), window, cx)).into(),
				panel:    cx.new(|cx| RightPanel::new(shared.clone(), window, cx)).into(),
				drawer:   cx
					.new(|cx| TerminalDrawer::new(shared.clone(), window, cx))
					.into(),
				palette:  palette.into(),
				settings: settings.into(),
			}
		} else {
			let mut empty = || AnyView::from(cx.new(|_| EmptyView));
			Regions {
				sidebar:  empty(),
				thread:   empty(),
				panel:    empty(),
				drawer:   empty(),
				palette:  palette.into(),
				settings: settings.into(),
			}
		};
		Workspace::new(view_state.clone(), regions, PanelsStore::default(), window, cx)
	});
	cx.simulate_resize(size(px(WINDOW.0), px(WINDOW.1)));
	cx.run_until_parked();
	let (palette, settings) = built.expect("the window built its regions");
	if whole {
		state.update(cx, |state, _| state.drain_outbox());
	}
	Win { state, palette, settings, cx }
}

impl Win<'_> {
	/// Every request queued since the last drain.
	pub fn outbox(&mut self) -> Vec<HostAction> {
		self.state.update(self.cx, |state, _| {
			state
				.drain_outbox()
				.into_iter()
				.map(|request| request.action)
				.collect()
		})
	}

	/// The requests queued since the last drain, the file searches typing
	/// sends left out.
	pub fn sent(&mut self) -> Vec<HostAction> {
		let mut sent = self.outbox();
		sent.retain(|action| !matches!(action, HostAction::SearchFiles { .. }));
		sent
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

	/// Opens the palette the way its binding does.
	pub fn open(&mut self) {
		self.dispatch(veyyon_desktop_app::actions::workspace::TogglePalette);
	}

	pub fn is_open(&self) -> bool {
		self
			.palette
			.read_with(&*self.cx, |palette, _| palette.is_open())
	}

	pub fn keys(&mut self, keys: &str) {
		self.cx.simulate_keystrokes(keys);
		self.cx.run_until_parked();
	}

	pub fn typed(&mut self, text: &str) {
		self.cx.simulate_input(text);
		self.cx.run_until_parked();
	}

	/// Replaces the query with `text`.
	pub fn query(&mut self, text: &str) {
		self.keys("ctrl-a backspace");
		self.typed(text);
	}

	pub fn rows(&self) -> Vec<Item> {
		self
			.palette
			.read_with(&*self.cx, |palette, _| palette.shown().cloned().collect())
	}

	pub fn labels(&self) -> Vec<String> {
		self
			.rows()
			.iter()
			.map(|item| item.label.to_string())
			.collect()
	}

	/// The index among the drawn rows of the row reading `label`.
	pub fn row_of(&self, label: &str) -> usize {
		let labels = self.labels();
		labels
			.iter()
			.position(|drawn| drawn == label)
			.unwrap_or_else(|| panic!("a row reads {label:?}; the rows read {labels:?}"))
	}

	pub fn selected(&self) -> usize {
		self
			.palette
			.read_with(&*self.cx, |palette, _| palette.selected())
	}

	pub fn bounds(&mut self, id: &str) -> Option<Bounds<Pixels>> {
		self
			.cx
			.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
	}

	pub fn click_at(&mut self, at: Point<Pixels>) {
		self.cx.simulate_click(at, Modifiers::none());
		self.cx.run_until_parked();
	}

	pub fn click(&mut self, id: &str) {
		let at = self
			.bounds(id)
			.unwrap_or_else(|| panic!("{id} is laid out"))
			.center();
		self.click_at(at);
	}

	/// Walks the highlight down to the drawn row reading `label`, which
	/// scrolls it into view, and clicks it.
	pub fn pick(&mut self, label: &str) {
		let row = self.row_of(label);
		let from = self.selected();
		assert!(from <= row, "the highlight starts above {label:?}");
		for _ in from..row {
			self.keys("down");
		}
		assert_eq!(self.selected(), row, "down walks the highlight to {label:?}");
		self.click(&format!("palette.row:{row}"));
	}

	/// The text the last frame drew.
	pub fn texts(&mut self) -> Vec<String> {
		self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.map(|run| run.text.to_string())
				.collect()
		})
	}

	pub fn layout(&mut self) -> WorkspaceLayout {
		self.cx.update(|_, cx| WorkspaceLayout::get(cx).clone())
	}

	/// How many times the palette and settings have rendered.
	pub fn renders(&self) -> (usize, usize) {
		let palette = self
			.palette
			.read_with(&*self.cx, |palette, _| palette.render_count());
		let settings = self
			.settings
			.read_with(&*self.cx, |settings, _| settings.render_count());
		(palette, settings)
	}
}

pub fn sid(id: &str) -> SessionId {
	SessionId::from(id)
}

fn entry(id: &str, parent: Option<&str>, revision: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: parent.map(EntryId::from),
		revision,
		timestamp_ms: revision,
		role: MessageRole::Assistant,
		content: Vec::new(),
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

fn summary(id: &str, cwd: &str, modified_at_ms: u64) -> SessionSummary {
	SessionSummary {
		id: sid(id),
		workspace: "ws-default".to_owned(),
		path: format!("/sessions/{id}.jsonl"),
		cwd: cwd.to_owned(),
		title: Some(format!("title {id}")),
		parent_path: None,
		created_at_ms: 0,
		modified_at_ms,
		message_count: 1,
		size_bytes: 1,
		first_message: None,
		searchable_messages: None,
		status: SessionStatus::Complete,
	}
}

/// Threads `a` and `b` under `/w/alpha` and `c` under `/w/beta`, none open.
pub fn listed() -> Vec<HostEvent> {
	vec![HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned {
			revision: 1,
			value:    vec![
				summary("a", "/w/alpha", 100),
				summary("b", "/w/alpha", 200),
				summary("c", "/w/beta", 50),
			],
		},
		Vec::new(),
	))]
}

/// [`listed`], with `a` open.
pub fn seeded() -> Vec<HostEvent> {
	let header = SessionHeaderView {
		id:             sid("a"),
		schema_version: 1,
		title:          Some("title a".to_owned()),
		title_source:   None,
		parent:         None,
		created_at_ms:  0,
		cwd:            "/w/alpha".to_owned(),
		mode:           None,
	};
	let mut events = listed();
	events.extend([
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 1,
			value:    header,
		})),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    vec![entry("a-0", None, 1)],
		})),
	]);
	events
}

/// One streamed delta of the reply to `a`.
pub fn delta(revision: u64) -> HostEvent {
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry: EntryId::from("a-1"),
		tool: None,
		accumulating: entry("a-1", Some("a-0"), revision),
		revision,
	}))
}
