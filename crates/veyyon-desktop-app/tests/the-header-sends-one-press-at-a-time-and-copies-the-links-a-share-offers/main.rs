//! The thread header's buttons send one request per press the host takes,
//! and its sharing chip opens the share the window is in: each link a
//! hosted share offers, copied whole, or the room a joined one is in.
//!
//! WHY: every button the header draws for a host request is built by one
//! function. A button live while its press is in flight asks the host twice
//! for one compaction, one export or one share; one live while the host
//! withholds its capability sends a request the host refuses; and a share
//! button that reads only whether a share exists sends Stop from a window
//! that joined someone else's. A hosting window that draws its share and
//! none of its links leaves nothing to send a guest. The suite drives the
//! real `ThreadHeader` over an `AppState` fed host events, presses each
//! button through the driver, answers what it sent, and reads the requests,
//! the text runs drawn and the clipboard.
//!
//! Gap: the header's buttons are listed here; a button drawn by other means
//! than the header's one builder is not swept. The chip is found by its
//! driver target and the menu by its text runs; pixels are not read.

mod links;
mod presses;

use gpui::{
	AppContext as _, Bounds, ClipboardItem, Entity, Modifiers, Pixels, TestAppContext,
	VisualTestContext, px, size,
};
use veyyon_desktop_app::{AppState, driver, keymap, thread::header::ThreadHeader};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, HostAction, HostEvent, HostRequest, RequestId, SessionHeaderView,
	SessionId, SnapshotSection, Store, Versioned,
	domain::{ShareRole, ShareView},
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

/// The window every test draws in.
pub const WINDOW: (f32, f32) = (1600.0, 400.0);

pub struct Win<'a> {
	pub state: Entity<AppState>,
	pub cx:    &'a mut VisualTestContext,
}

/// Opens a window holding only the header of session `s`, over a store fed
/// `events`, and drops the requests the events queued.
pub fn window(app: &mut TestAppContext, events: Vec<HostEvent>) -> Win<'_> {
	driver::enable();
	app.update(|cx| {
		Theme::install(Appearance::Dark, cx).expect("the dark palette parses");
		veyyon_desktop_app::init(cx);
		keymap::install(cx).expect("the default keymap parses");
		cx.set_reduce_motion(true);
	});
	let state = app.new(|_| AppState::new(Store::new()));
	state.update(app, |state, cx| state.apply(vec![opened()], cx));
	state.update(app, |state, cx| state.apply(events, cx));
	state.update(app, |state, _| state.drain_outbox());
	let view_state = state.clone();
	let (_, cx) = app.add_window_view(|window, cx| ThreadHeader::new(view_state, window, cx));
	cx.simulate_resize(size(px(WINDOW.0), px(WINDOW.1)));
	cx.run_until_parked();
	Win { state, cx }
}

impl Win<'_> {
	pub fn apply(&mut self, events: Vec<HostEvent>) {
		self
			.state
			.update(self.cx, |state, cx| state.apply(events, cx));
		self.cx.run_until_parked();
	}

	/// Every request queued since the last drain.
	pub fn requests(&mut self) -> Vec<HostRequest> {
		self.state.update(self.cx, |state, _| state.drain_outbox())
	}

	/// The actions queued since the last drain.
	pub fn sent(&mut self) -> Vec<HostAction> {
		self
			.requests()
			.into_iter()
			.map(|request| request.action)
			.collect()
	}

	/// Where the driver target `id` was last laid out.
	pub fn bounds(&mut self, id: &str) -> Option<Bounds<Pixels>> {
		self
			.cx
			.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
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

	/// Presses `keys`, space-separated as gpui spells them.
	pub fn keys(&mut self, keys: &str) {
		self.cx.simulate_keystrokes(keys);
		self.cx.run_until_parked();
	}

	/// Every text run the last frame drew, and where.
	pub fn runs(&mut self) -> Vec<(String, Bounds<Pixels>)> {
		self.cx.update(|window, _| {
			window
				.rendered_text_runs()
				.iter()
				.map(|run| (run.text.to_string(), run.bounds))
				.collect()
		})
	}

	/// Whether the last frame drew a run reading `text`.
	pub fn draws(&mut self, text: &str) -> bool {
		self.runs().iter().any(|(run, _)| run == text)
	}

	/// Empties the clipboard.
	pub fn clear_clipboard(&mut self) {
		self
			.cx
			.write_to_clipboard(ClipboardItem::new_string(String::new()));
	}

	/// The text on the clipboard.
	pub fn clipboard(&mut self) -> Option<String> {
		self.cx.read_from_clipboard().and_then(|item| item.text())
	}
}

pub fn sid() -> SessionId {
	SessionId::from("s")
}

/// Session `s` open.
pub fn opened() -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::ActiveSession(Versioned {
		revision: 1,
		value:    SessionHeaderView {
			id:             sid(),
			schema_version: 1,
			title:          Some("Index the repo".to_owned()),
			title_source:   None,
			parent:         None,
			created_at_ms:  0,
			cwd:            "/w/s".to_owned(),
			mode:           None,
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

/// The host answering `request`.
pub const fn answered(request: RequestId) -> HostEvent {
	HostEvent::RequestSucceeded { request }
}

/// A share this window is on the `role` side of, offering none of its links.
pub fn share(role: ShareRole) -> ShareView {
	ShareView {
		state: match role {
			ShareRole::Off => "off",
			ShareRole::Hosting => "hosting",
			ShareRole::Guest => "joined",
		}
		.to_owned(),
		role,
		relay_url: Some("wss://relay.example.net".to_owned()),
		link: None,
		web_link: None,
		view_link: None,
		web_view_link: None,
		participants: Vec::new(),
		guest: None,
		error: None,
	}
}

/// The host stating `share`.
pub const fn stated(share: ShareView) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Share(share))
}
