//! A whole window over one `AppState` attached to a host that takes every
//! request, and the gestures a sender performs on it.

use std::{fs, path::PathBuf, time::Duration};

use gpui::{
	AppContext as _, Bounds, Entity, Modifiers, Pixels, Point, ScrollDelta, ScrollWheelEvent,
	TestAppContext, VisualTestContext, px, size,
};
use serde_json::json;
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::{
	AppState,
	drawer::TerminalDrawer,
	driver, keymap,
	palette::CommandPalette,
	panel::RightPanel,
	settings::SettingsView,
	sidebar::Sidebar,
	thread::ThreadView,
	workspace::{Regions, Workspace, WorkspaceLayout},
};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, HostAction, HostEvent, PROTOCOL_VERSION,
	PanelsStore, SnapshotSection, SnapshotSectionKind, Store,
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// Tall and wide enough that a settings page, the panel and the drawer are
/// laid out whole beside the thread.
const WINDOW: (f32, f32) = (1600.0, 1200.0);

pub struct Win<'a> {
	pub state:  Entity<AppState>,
	pub panel:  Entity<RightPanel>,
	pub drawer: Entity<TerminalDrawer>,
	pub cx:     &'a mut VisualTestContext,
}

/// Installs the theme, the app's App-level listeners and the default keymap,
/// once for every window the test opens.
pub fn install(app: &TestAppContext) {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
		keymap::install(cx).expect("the default keymap parses");
		cx.set_reduce_motion(true);
	});
}

/// Opens a window at the default layout over [`world`], activates it so a
/// chord reaches its focused region, and drops the requests the events and
/// the regions queued while it opened.
pub fn window(app: &mut TestAppContext) -> Win<'_> {
	// The layout is App-wide; each window starts from the default rather
	// than from the regions the window before it opened.
	app.update(|cx| cx.set_global(WorkspaceLayout::default()));
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(world(), cx));
	let shared = state.clone();
	let mut built = None;
	let (_, cx) = app.add_window_view(|window, cx| {
		let panel = cx.new(|cx| RightPanel::new(shared.clone(), window, cx));
		let drawer = cx.new(|cx| TerminalDrawer::new(shared.clone(), window, cx));
		built = Some((panel.clone(), drawer.clone()));
		let regions = Regions {
			sidebar:  cx.new(|cx| Sidebar::new(shared.clone(), window, cx)).into(),
			thread:   cx
				.new(|cx| ThreadView::new(shared.clone(), window, cx))
				.into(),
			panel:    panel.into(),
			drawer:   drawer.into(),
			palette:  cx
				.new(|cx| CommandPalette::new(shared.clone(), window, cx))
				.into(),
			settings: cx
				.new(|cx| SettingsView::new(shared.clone(), window, cx))
				.into(),
		};
		Workspace::new(shared.clone(), regions, PanelsStore::default(), window, cx)
	});
	cx.simulate_resize(size(px(WINDOW.0), px(WINDOW.1)));
	cx.update(|window, _| window.activate_window());
	cx.run_until_parked();
	let (panel, drawer) = built.expect("the window built its regions");
	state.update(cx, |state, _| state.drain_outbox());
	Win { state, panel, drawer, cx }
}

/// A host the window is attached to that grants every capability, with the
/// thread `sess-1` open and idle, terminal `term-1` running, process `web`
/// running and agent `agent-0` working in session `history-1`.
pub fn world() -> Vec<HostEvent> {
	let every = Capability::iter()
		.map(|capability| (capability, CapabilityStatus::Available))
		.collect();
	let sections = [
		SnapshotSection::Capabilities(every),
		section(json!({ "Sessions": [{ "revision": 1, "value": [{
			"id": "sess-1", "workspace": "repo", "path": "/repo/.veyyon/sessions/sess-1.jsonl",
			"cwd": "/repo", "title": "First thread", "parent_path": null,
			"created_at_ms": 1_600_000_000_000_u64, "modified_at_ms": 1_600_000_000_000_u64,
			"message_count": 1, "size_bytes": 1, "first_message": null,
			"searchable_messages": null, "status": "Complete"
		}] }, []] })),
		section(json!({ "ActiveSession": { "revision": 1, "value": {
			"id": "sess-1", "schema_version": 1, "title": "First thread", "title_source": null,
			"parent": null, "created_at_ms": 1_600_000_000_000_u64, "cwd": "/repo", "mode": null
		} } })),
		section(json!({ "Transcript": { "revision": 1, "value": [{
			"id": "entry-0", "parent": null, "revision": 1, "timestamp_ms": 1_600_000_000_000_u64,
			"role": "User", "content": [{ "Text": { "text": "first words" } }], "meta": null,
			"raw_discriminator": "message", "raw": { "type": "message" }
		}] } })),
		section(json!({ "Terminals": [{
			"id": "term-1", "cwd": "/repo", "shell": "/bin/zsh", "cols": 80, "rows": 24,
			"status": "Running"
		}] })),
		section(json!({ "Processes": [{
			"name": "web", "pid": 1, "status": "running", "application": "sh", "args": [],
			"cwd": "/repo", "lifetime": "last-client-exit",
			"started_at_ms": 1_600_000_000_000_u64, "exit_code": null, "terminated_by": null
		}] })),
		section(json!({ "Agents": [{
			"id": "agent-0", "call_sign": "Wren", "display_name": "Reader", "kind": "sub",
			"status": "running", "parent": "main", "scope": "/repo", "session": "history-1",
			"activity": null, "model": null
		}] })),
	];
	let mut events = vec![HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "gui-host".to_owned(),
		protocol: PROTOCOL_VERSION,
	})];
	events.extend(sections.into_iter().map(HostEvent::Snapshot));
	events
}

/// A section as the host writes it on the wire.
pub fn section(value: serde_json::Value) -> SnapshotSection {
	serde_json::from_value(value).expect("a fixture section decodes")
}

/// The shared corpus entry of `kind`
/// (`veyyon-desktop-model/tests/fixtures/snapshot-sections.json`), for a
/// sender whose control draws only once the host has sent that section.
pub fn corpus(kind: SnapshotSectionKind) -> HostEvent {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../veyyon-desktop-model/tests/fixtures/snapshot-sections.json");
	let raw = fs::read_to_string(&path)
		.unwrap_or_else(|error| panic!("read the corpus at {}: {error}", path.display()));
	let sections: Vec<SnapshotSection> =
		serde_json::from_str(&raw).expect("the corpus decodes into every section");
	let found = sections
		.into_iter()
		.find(|section| SnapshotSectionKind::from(section) == kind)
		.unwrap_or_else(|| panic!("the corpus holds a {kind:?} section"));
	HostEvent::Snapshot(found)
}

impl Win<'_> {
	/// Applies `events` as the host sending them.
	pub fn apply(&mut self, events: Vec<HostEvent>) {
		self
			.state
			.update(self.cx, |state, cx| state.apply(events, cx));
		self.cx.run_until_parked();
	}

	/// Dispatches `action` to the focused element. A drive uses it only to
	/// reach a surface through an action the default keymap binds or a
	/// palette row runs, never as the gesture that sends.
	pub fn dispatch(&mut self, action: impl gpui::Action) {
		self.cx.dispatch_action(action);
		self.cx.run_until_parked();
	}

	/// Presses `keys`, space separated, the way [`gpui`] spells a chord.
	pub fn keys(&mut self, keys: &str) {
		self.cx.simulate_keystrokes(keys);
		self.cx.run_until_parked();
	}

	/// Types `text` into whatever holds the keys.
	pub fn typed(&mut self, text: &str) {
		self.cx.simulate_input(text);
		self.cx.run_until_parked();
	}

	/// Opens the palette with its chord, types `query` and runs the row it
	/// ranks first.
	pub fn palette(&mut self, query: &str) {
		self.keys("secondary-k");
		self.typed(query);
		self.keys("enter");
	}

	/// Lets `time` pass, so a pause the window waits out elapses.
	pub fn wait(&self, time: Duration) {
		self.cx.executor().advance_clock(time);
		self.cx.run_until_parked();
	}

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

	/// The text the last frame drew, in paint order.
	pub fn texts(&mut self) -> Vec<String> {
		self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.map(|run| run.text.to_string())
				.collect()
		})
	}

	/// Where the driver target `id` was last laid out.
	pub fn bounds(&mut self, id: &str) -> Option<Bounds<Pixels>> {
		self
			.cx
			.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
	}

	pub fn click_at(&mut self, at: Point<Pixels>) {
		self.cx.simulate_click(at, Modifiers::none());
		self.cx.run_until_parked();
	}

	/// Clicks the centre of the driver target `id` a fresh frame lays out.
	pub fn click(&mut self, id: &str) {
		self.cx.update(|window, _| window.refresh());
		self.cx.run_until_parked();
		let at = self
			.bounds(id)
			.unwrap_or_else(|| panic!("the window lays out {id}"))
			.center();
		self.click_at(at);
	}

	/// Clicks the centre of the first run a fresh frame draws reading `text`
	/// once trimmed.
	pub fn click_text(&mut self, text: &str) {
		self.cx.update(|window, _| window.refresh());
		self.cx.run_until_parked();
		let at = self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.find(|run| run.text.trim() == text)
				.map(|run| run.bounds.center())
		});
		self.click_at(at.unwrap_or_else(|| panic!("the window draws {text:?}")));
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
}
