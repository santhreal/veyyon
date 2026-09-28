//! A window whose workspace lays out the real terminal drawer over a store
//! fed host events, every other region empty, and the host events the
//! suites feed it.

use gpui::{
	AnyView, AppContext as _, Bounds, EmptyView, Entity, Modifiers, Pixels, Point, ScrollDelta,
	ScrollWheelEvent, TestAppContext, VisualTestContext, px, size,
};
use veyyon_desktop_app::{
	AppState,
	actions::workspace as act,
	drawer::{DrawerTab, TerminalDrawer},
	driver, keymap,
	workspace::{Regions, Workspace, WorkspaceLayout},
};
use veyyon_desktop_model::{
	BackendError, Capability, CapabilityStatus, EntryId, ErrorScope, HostAction, HostEvent,
	HostRequest, MessageRole, PanelsStore, ProcessLogsChunk, ProcessView, RequestId,
	SessionHeaderView, SessionId, SnapshotSection, Store, StreamingMessageState,
	TerminalOutputChunk, TerminalStatus, TerminalView, TranscriptEntry, Versioned,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// The session every suite shows.
pub const SESSION: &str = "s";

/// The directory `SESSION` runs in.
pub const CWD: &str = "/w/s";

pub struct Win<'a> {
	pub state:  Entity<AppState>,
	pub drawer: Entity<TerminalDrawer>,
	pub cx:     &'a mut VisualTestContext,
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
		let drawer = cx.new(|cx| TerminalDrawer::new(view_state.clone(), window, cx));
		built = Some(drawer.clone());
		let mut empty = || AnyView::from(cx.new(|_| EmptyView));
		let regions = Regions {
			sidebar:  empty(),
			thread:   empty(),
			panel:    empty(),
			drawer:   drawer.into(),
			palette:  empty(),
			settings: empty(),
		};
		Workspace::new(view_state, regions, PanelsStore::default(), window, cx)
	});
	cx.simulate_resize(size(px(1200.0), px(800.0)));
	cx.run_until_parked();
	let drawer = built.expect("the window built its regions");
	Win { state, drawer, cx }
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

	/// The one request queued since the last drain.
	pub fn one(&mut self) -> HostRequest {
		let mut requests = self.requests();
		assert_eq!(requests.len(), 1, "one request is queued: {requests:?}");
		requests.remove(0)
	}

	pub fn apply(&mut self, events: Vec<HostEvent>) {
		self
			.state
			.update(self.cx, |state, cx| state.apply(events, cx));
		self.cx.run_until_parked();
	}

	/// Opens or closes the drawer the way its binding does.
	pub fn toggle(&mut self) {
		self.cx.dispatch_action(act::ToggleDrawer);
		self.cx.run_until_parked();
	}

	pub fn keys(&mut self, keys: &str) {
		self.cx.simulate_keystrokes(keys);
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

	/// Turns the wheel by `delta` over `at`.
	pub fn scroll(&mut self, at: Point<Pixels>, delta: Point<Pixels>) {
		self.cx.simulate_event(ScrollWheelEvent {
			position: at,
			delta: ScrollDelta::Pixels(delta),
			..ScrollWheelEvent::default()
		});
		self.cx.run_until_parked();
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

	/// Focuses the field showing `placeholder`, types `text` and presses
	/// Enter.
	pub fn submit(&mut self, placeholder: &str, text: &str) {
		self.click_text(placeholder);
		self.cx.simulate_input(text);
		self.cx.run_until_parked();
		self.keys("enter");
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

	pub fn layout(&mut self) -> WorkspaceLayout {
		self.cx.update(|_, cx| WorkspaceLayout::get(cx).clone())
	}

	pub fn renders(&self) -> u64 {
		self
			.drawer
			.read_with(&*self.cx, |drawer, _| drawer.render_count())
	}

	pub fn shown(&self) -> Option<DrawerTab> {
		self
			.drawer
			.read_with(&*self.cx, |drawer, cx| drawer.shown(cx))
	}

	pub fn strip(&self) -> Vec<DrawerTab> {
		self
			.drawer
			.read_with(&*self.cx, |drawer, _| drawer.strip().to_vec())
	}

	/// The columns and rows the drawer measured its grid to hold.
	pub fn cells(&self) -> Option<(u16, u16)> {
		self.drawer.read_with(&*self.cx, |drawer, _| drawer.cells())
	}

	/// Resizes the window to `width` by `height` and lets the frames it
	/// raised settle.
	pub fn resize(&self, width: f32, height: f32) {
		self.cx.simulate_resize(size(px(width), px(height)));
		self.cx.run_until_parked();
	}

	/// The columns and rows `tab`'s screen draws, once the drawer built one.
	pub fn grid(&self, tab: &DrawerTab) -> Option<(usize, usize)> {
		self.drawer.read_with(&*self.cx, |drawer, _| {
			drawer.screen(tab).map(|screen| {
				let grid = screen.emulator().grid();
				(grid.cols, grid.rows)
			})
		})
	}
}

/// `SESSION` open with one entry, and the host's `capabilities`.
pub fn opened(capabilities: Vec<(Capability, CapabilityStatus)>) -> Vec<HostEvent> {
	let header = SessionHeaderView {
		id:             SessionId::from(SESSION),
		schema_version: 1,
		title:          None,
		title_source:   None,
		parent:         None,
		created_at_ms:  0,
		cwd:            CWD.to_owned(),
		mode:           None,
	};
	vec![
		HostEvent::Snapshot(SnapshotSection::Capabilities(capabilities)),
		HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
			revision: 1,
			value:    header,
		})),
		HostEvent::Snapshot(SnapshotSection::Transcript(Versioned {
			revision: 1,
			value:    vec![entry("s-0", 1)],
		})),
	]
}

/// A host that runs terminals and supervises processes.
pub fn both() -> Vec<(Capability, CapabilityStatus)> {
	vec![
		(Capability::Terminals, CapabilityStatus::Available),
		(Capability::ProcessSupervisor, CapabilityStatus::Available),
	]
}

/// The host stating `list` as its capabilities.
pub const fn capabilities(list: Vec<(Capability, CapabilityStatus)>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Capabilities(list))
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

/// A terminal `id` running `/bin/zsh`, or ended as `status`.
pub fn terminal(id: &str, status: TerminalStatus) -> TerminalView {
	TerminalView {
		id: id.to_owned(),
		cwd: CWD.to_owned(),
		shell: "/bin/zsh".to_owned(),
		cols: 80,
		rows: 24,
		status,
	}
}

pub const fn terminals(list: Vec<TerminalView>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Terminals(list))
}

/// `data` written by terminal `id`.
pub fn output(id: &str, seq: u64, data: &str) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::TerminalOutput(TerminalOutputChunk {
		terminal: id.to_owned(),
		seq,
		data: data.as_bytes().to_vec(),
		reset: false,
	}))
}

/// A process `name` the supervisor runs as `bun run dev`, in `status`.
pub fn process(name: &str, status: &str, exit_code: Option<i32>) -> ProcessView {
	ProcessView {
		name: name.to_owned(),
		pid: (exit_code.is_none()).then_some(4242),
		status: status.to_owned(),
		application: "bun".to_owned(),
		args: vec!["run".to_owned(), "dev".to_owned()],
		cwd: CWD.to_owned(),
		lifetime: "last-client-exit".to_owned(),
		started_at_ms: 0,
		exit_code,
		terminated_by: None,
	}
}

pub const fn processes(list: Vec<ProcessView>) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Processes(list))
}

/// `lines` written by process `name`.
pub fn logs(name: &str, lines: &[&str]) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ProcessLogs(ProcessLogsChunk {
		process: name.to_owned(),
		lines:   lines.iter().map(|line| (*line).to_owned()).collect(),
		cursor:  lines.len() as u64,
		reset:   false,
	}))
}

pub const fn succeeded(request: RequestId) -> HostEvent {
	HostEvent::RequestSucceeded { request }
}

/// The host's refusal of `request`, stated as `message`.
pub fn refused(request: RequestId, message: &str) -> HostEvent {
	HostEvent::RequestFailed {
		request,
		error: BackendError {
			scope:          ErrorScope::Terminal,
			code:           Some("refused".to_owned()),
			message:        message.to_owned(),
			retryable:      true,
			request:        Some(request),
			occurred_at_ms: 1,
		},
	}
}
