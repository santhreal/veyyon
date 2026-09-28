//! A window whose workspace lays out the real right panel over a store fed
//! host events, every other region empty, and the host events the suites
//! feed it.

use gpui::{
	AnyView, AppContext as _, Bounds, EmptyView, Entity, Modifiers, Pixels, Point, ScrollDelta,
	ScrollWheelEvent, TestAppContext, VisualTestContext, px, size,
};
use veyyon_desktop_app::{
	AppState,
	actions::workspace as act,
	driver, keymap,
	panel::{PanelTab, RightPanel},
	workspace::{Regions, Workspace, WorkspaceLayout},
};
use veyyon_desktop_model::{
	AgentView, EntryId, HostAction, HostEvent, HostRequest, MessageRole, PanelsStore,
	SessionHeaderView, SessionId, SnapshotSection, Store, StreamingMessageState, TranscriptEntry,
	Versioned,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// The session every suite shows.
pub const SESSION: &str = "s";

pub struct Win<'a> {
	pub state: Entity<AppState>,
	pub panel: Entity<RightPanel>,
	pub cx:    &'a mut VisualTestContext,
}

/// Opens the window over a store fed `events` and drops the requests the
/// events queued.
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
	state.update(app, |state, _| state.drain_outbox());
	let view_state = state.clone();
	let mut built = None;
	let (_, cx) = app.add_window_view(|window, cx| {
		let panel = cx.new(|cx| RightPanel::new(view_state.clone(), window, cx));
		built = Some(panel.clone());
		let mut empty = || AnyView::from(cx.new(|_| EmptyView));
		let regions = Regions {
			sidebar:  empty(),
			thread:   empty(),
			panel:    panel.into(),
			drawer:   empty(),
			palette:  empty(),
			settings: empty(),
		};
		Workspace::new(view_state, regions, PanelsStore::default(), window, cx)
	});
	cx.simulate_resize(size(px(1400.0), px(900.0)));
	cx.run_until_parked();
	let panel = built.expect("the window built its regions");
	Win { state, panel, cx }
}

impl Win<'_> {
	/// Every request queued since the last drain.
	pub fn requests(&mut self) -> Vec<HostRequest> {
		self.state.update(self.cx, |state, _| state.drain_outbox())
	}

	/// The actions of every request queued since the last drain.
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

	/// Opens the panel on `tab` the way the palette and a link do.
	pub fn open(&mut self, tab: PanelTab) {
		self
			.cx
			.dispatch_action(act::ShowPanelTab { tab: tab.name().into() });
		self.cx.run_until_parked();
	}

	/// Opens or closes the panel the way its binding does.
	pub fn toggle(&mut self) {
		self.cx.dispatch_action(act::TogglePanel);
		self.cx.run_until_parked();
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

	/// Clicks the first drawn run that reads `text` in full.
	pub fn click_text(&mut self, text: &str) {
		let at = self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.find(|run| run.text.trim() == text)
				.map(|run| run.bounds.center())
		});
		self.click_at(at.unwrap_or_else(|| panic!("{text:?} is drawn")));
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

	pub fn draws(&mut self, text: &str) -> bool {
		self.texts().iter().any(|drawn| drawn.contains(text))
	}

	/// Where the last frame drew the first run that holds `text`.
	pub fn run(&mut self, text: &str) -> Option<Bounds<Pixels>> {
		self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.find(|run| run.text.contains(text))
				.map(|run| run.bounds)
		})
	}

	/// Where the last frame drew the first run that reads `text` in full.
	pub fn run_exact(&mut self, text: &str) -> Option<Bounds<Pixels>> {
		self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.find(|run| run.text.trim() == text)
				.map(|run| run.bounds)
		})
	}

	/// Turns the wheel by `delta` over `at`.
	pub fn scroll(&mut self, at: Point<Pixels>, delta: Point<Pixels>) {
		self.cx.simulate_event(ScrollWheelEvent {
			position: at,
			delta: ScrollDelta::Pixels(delta),
			..ScrollWheelEvent::default()
		});
		self.cx.run_until_parked();
	}

	pub fn layout(&mut self) -> WorkspaceLayout {
		self.cx.update(|_, cx| WorkspaceLayout::get(cx).clone())
	}

	pub fn active(&self) -> PanelTab {
		self.panel.read_with(&*self.cx, |panel, _| panel.active())
	}

	/// The render counts of the panel and of the diff and files tabs.
	pub fn renders(&self) -> [u64; 3] {
		self.panel.read_with(&*self.cx, |panel, cx| {
			[
				panel.render_count(),
				panel.diff().read(cx).render_count(),
				panel.files().read(cx).render_count(),
			]
		})
	}

	/// The tab the displayed session reopens on.
	pub fn persisted(&self) -> Option<String> {
		self
			.state
			.read_with(&*self.cx, |state, _| state.active_right_tab().map(str::to_owned))
	}
}

/// The host opening `session` with one entry.
pub fn opened(session: &str) -> Vec<HostEvent> {
	let header = SessionHeaderView {
		id:             SessionId::from(session),
		schema_version: 1,
		title:          None,
		title_source:   None,
		parent:         None,
		created_at_ms:  0,
		cwd:            format!("/w/{session}"),
		mode:           None,
	};
	vec![
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 1,
			value:    header,
		})),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    vec![entry(&format!("{session}-0"), 1)],
		})),
	]
}

/// An assistant entry with no content.
fn entry(id: &str, revision: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: None,
		revision,
		timestamp_ms: revision,
		role: MessageRole::Assistant,
		content: Vec::new(),
		meta: None,
		raw_discriminator: String::new(),
		raw: serde_json::Value::Null,
	}
}

/// A streamed delta of the reply being written.
pub fn delta(revision: u64) -> HostEvent {
	HostEvent::StreamingChanged(Some(StreamingMessageState {
		entry: EntryId::from("s-tail"),
		tool: None,
		accumulating: entry("s-tail", revision),
		revision,
	}))
}

/// An agent `id` called `call_sign`, of `kind`, in `status`, owning
/// `session`.
pub fn agent(
	id: &str,
	call_sign: &str,
	kind: &str,
	status: &str,
	session: Option<&str>,
) -> AgentView {
	AgentView {
		id:           id.to_owned(),
		call_sign:    call_sign.to_owned(),
		display_name: String::new(),
		kind:         kind.to_owned(),
		status:       status.to_owned(),
		parent:       None,
		scope:        "/w/s".to_owned(),
		session:      session.map(SessionId::from),
		activity:     None,
		model:        None,
	}
}
