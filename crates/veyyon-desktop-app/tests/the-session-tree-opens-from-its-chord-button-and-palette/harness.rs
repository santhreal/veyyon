//! A whole window over a store fed host events: the real sidebar, thread
//! column, panel, drawer, palette and settings, with the sidebar, the thread
//! column and the palette held for the tests to read.

use gpui::{
	AppContext as _, Entity, Focusable, Modifiers, TestAppContext, VisualTestContext, px, size,
};
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::{
	AppState,
	actions::workspace::TogglePalette,
	drawer::TerminalDrawer,
	driver, keymap,
	palette::CommandPalette,
	panel::RightPanel,
	settings::SettingsView,
	sidebar::Sidebar,
	thread::{ThreadView, tree::SessionTreeSheet},
	workspace::{Regions, Workspace},
};
use veyyon_desktop_model::{
	EntryId, HostAction, HostEvent, MessageRole, PanelsStore, SessionHeaderView, SessionId,
	SessionStatus, SessionSummary, SnapshotSection, Store, TranscriptEntry, TreeRequest, Versioned,
	domain::{SessionTreeEntryKind, SessionTreeFilter, SessionTreeNode, SessionTreeView},
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

pub struct Win<'a> {
	pub state:   Entity<AppState>,
	pub sidebar: Entity<Sidebar>,
	pub thread:  Entity<ThreadView>,
	pub palette: Entity<CommandPalette>,
	pub cx:      &'a mut VisualTestContext,
}

/// Opens the whole window over a store fed `events` and drops the requests
/// the events and the regions queued.
pub fn window(app: &mut TestAppContext, events: Vec<HostEvent>) -> Win<'_> {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
		keymap::install(cx).expect("the default keymap parses");
		cx.set_reduce_motion(true);
	});
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(events, cx));
	let shared = state.clone();
	let mut built = None;
	let (_, cx) = app.add_window_view(|window, cx| {
		let sidebar = cx.new(|cx| Sidebar::new(shared.clone(), window, cx));
		let thread = cx.new(|cx| ThreadView::new(shared.clone(), window, cx));
		let palette = cx.new(|cx| CommandPalette::new(shared.clone(), window, cx));
		built = Some((sidebar.clone(), thread.clone(), palette.clone()));
		let regions = Regions {
			sidebar:  sidebar.into(),
			thread:   thread.into(),
			panel:    cx
				.new(|cx| RightPanel::new(shared.clone(), window, cx))
				.into(),
			drawer:   cx
				.new(|cx| TerminalDrawer::new(shared.clone(), window, cx))
				.into(),
			palette:  palette.into(),
			settings: cx
				.new(|cx| SettingsView::new(shared.clone(), window, cx))
				.into(),
		};
		Workspace::new(shared.clone(), regions, PanelsStore::default(), window, cx)
	});
	cx.simulate_resize(size(px(1200.0), px(800.0)));
	cx.run_until_parked();
	let (sidebar, thread, palette) = built.expect("the window built its regions");
	state.update(cx, |state, _| state.drain_outbox());
	Win { state, sidebar, thread, palette, cx }
}

impl Win<'_> {
	/// The tree requests queued since the last drain; every other request
	/// is dropped.
	pub fn tree_sent(&mut self) -> Vec<TreeRequest> {
		self.state.update(self.cx, |state, _| {
			state
				.drain_outbox()
				.into_iter()
				.filter_map(|request| match request.action {
					HostAction::Tree(tree) => Some(tree),
					_ => None,
				})
				.collect()
		})
	}

	pub fn apply(&mut self, events: Vec<HostEvent>) {
		self
			.state
			.update(self.cx, |state, cx| state.apply(events, cx));
		self.cx.run_until_parked();
	}

	pub fn keys(&mut self, keys: &str) {
		self.cx.simulate_keystrokes(keys);
		self.cx.run_until_parked();
	}

	/// Clicks the middle of the driver target `id`.
	pub fn click(&mut self, id: &str) {
		let at = self
			.cx
			.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
			.unwrap_or_else(|| panic!("{id} is laid out"))
			.center();
		self.cx.simulate_click(at, Modifiers::none());
		self.cx.run_until_parked();
	}

	/// Whether the driver target `id` was laid out.
	pub fn drawn(&mut self, id: &str) -> bool {
		self
			.cx
			.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
			.is_some()
	}

	/// Opens the palette, types `typed` and clicks the row reading `label`.
	pub fn pick(&mut self, typed: &str, label: &str) {
		self.cx.dispatch_action(TogglePalette);
		self.cx.run_until_parked();
		self.cx.simulate_input(typed);
		self.cx.run_until_parked();
		let (labels, from) = self.palette.read_with(&*self.cx, |palette, _| {
			let labels: Vec<String> = palette.shown().map(|item| item.label.to_string()).collect();
			(labels, palette.selected())
		});
		let row = labels
			.iter()
			.position(|drawn| drawn == label)
			.unwrap_or_else(|| panic!("{typed:?} lists {label:?}; the rows read {labels:?}"));
		for _ in from..row {
			self.keys("down");
		}
		self.click(&format!("palette.row:{row}"));
	}

	/// The session tree sheet the thread column shows.
	pub fn sheet(&self) -> Option<Entity<SessionTreeSheet>> {
		self
			.thread
			.read_with(&*self.cx, |thread, _| thread.session_tree().cloned())
	}

	pub fn focused<V: Focusable>(&mut self, view: &Entity<V>) -> bool {
		let view = view.clone();
		self
			.cx
			.update(|window, cx| view.read(cx).focus_handle(cx).contains_focused(window, cx))
	}

	pub fn composer_focused(&mut self) -> bool {
		let composer = self
			.thread
			.read_with(&*self.cx, |thread, _| thread.composer().clone());
		self.focused(&composer)
	}

	pub fn sidebar_focused(&mut self) -> bool {
		let sidebar = self.sidebar.clone();
		self.focused(&sidebar)
	}

	/// Gives the sidebar's thread list the keyboard.
	pub fn focus_sidebar(&mut self) {
		let sidebar = self.sidebar.clone();
		self
			.cx
			.update(|window, cx| window.focus(&sidebar.focus_handle(cx), cx));
		self.cx.run_until_parked();
		assert!(self.sidebar_focused(), "the sidebar holds the keyboard");
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
}

pub fn sid(id: &str) -> SessionId {
	SessionId::from(id)
}

pub fn load(id: &str) -> TreeRequest {
	TreeRequest::LoadSessionTree { session: sid(id) }
}

pub fn fork(id: &str) -> TreeRequest {
	TreeRequest::ForkSession { session: sid(id) }
}

fn summary(id: &str, modified_at_ms: u64) -> SessionSummary {
	SessionSummary {
		id: sid(id),
		workspace: "ws-default".to_owned(),
		path: format!("/sessions/{id}.jsonl"),
		cwd: "/w/alpha".to_owned(),
		title: Some(format!("thread {id}")),
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

/// Threads `a` and `b`, none open.
pub fn listed() -> Vec<HostEvent> {
	vec![HostEvent::Snapshot(SnapshotSection::Sessions(
		Versioned { revision: 1, value: vec![summary("a", 100), summary("b", 200)] },
		Vec::new(),
	))]
}

/// The window moving to thread `id`.
pub fn opened(id: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
		revision: 1,
		value:    SessionHeaderView {
			id:             sid(id),
			schema_version: 1,
			title:          Some(format!("thread {id}")),
			title_source:   None,
			parent:         None,
			created_at_ms:  0,
			cwd:            "/w/alpha".to_owned(),
			mode:           None,
		},
	}))
}

/// [`listed`], with `a` open on one entry.
pub fn seeded() -> Vec<HostEvent> {
	let entry = TranscriptEntry {
		id:                EntryId::from("a-0"),
		parent:            None,
		revision:          1,
		timestamp_ms:      1,
		role:              MessageRole::Assistant,
		content:           Vec::new(),
		meta:              None,
		raw_discriminator: String::new(),
		raw:               serde_json::Value::Null,
	};
	let mut events = listed();
	events.extend([
		opened("a"),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    vec![entry],
		})),
	]);
	events
}

/// The text of the one row of [`tree`].
pub const ROOT: &str = "qjx the tree root";

/// The host's answer to `LoadSessionTree` for `id`: one user entry, the
/// leaf, shown in every filter.
pub fn tree(id: &str) -> HostEvent {
	let root = SessionTreeNode {
		id:       EntryId::from("a-0"),
		parent:   None,
		depth:    0,
		kind:     SessionTreeEntryKind::User,
		prefix:   "user: ".to_owned(),
		text:     ROOT.to_owned(),
		label:    None,
		on_path:  true,
		shown_in: SessionTreeFilter::iter().collect(),
	};
	HostEvent::Snapshot(SnapshotSection::SessionTree {
		session: sid(id),
		tree:    SessionTreeView {
			leaf:            Some(EntryId::from("a-0")),
			nodes:           vec![root],
			summary_offered: false,
			filter:          SessionTreeFilter::Default,
		},
	})
}
