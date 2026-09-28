//! A window whose workspace lays out the real settings over a store fed host
//! events, every other region empty, and the fixtures its pages draw.

use gpui::{
	AnyView, AppContext as _, Bounds, EmptyView, Entity, Modifiers, Pixels, Point, TestAppContext,
	VisualTestContext, px, size,
};
use serde_json::json;
use veyyon_desktop_app::{
	AppState,
	actions::workspace as act,
	driver, keymap,
	palette::CommandPalette,
	settings::{Page, SettingsView},
	workspace::{Regions, Workspace, WorkspaceLayout},
};
use veyyon_desktop_model::{
	BackendError, ErrorScope, HostAction, HostEvent, HostRequest, McpServerStatus, McpServerView,
	PanelsStore, ProviderView, RequestId, SettingsView as SettingsSection, SnapshotSection, Store,
	domain::{CredentialKind, McpRegistryView, StoredAccountView},
};
use veyyon_desktop_ui::theme::{Appearance, Theme};

pub struct Win<'a> {
	pub state:    Entity<AppState>,
	pub settings: Entity<SettingsView>,
	pub cx:       &'a mut VisualTestContext,
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
		let palette = cx.new(|cx| CommandPalette::new(view_state.clone(), window, cx));
		let settings = cx.new(|cx| SettingsView::new(view_state.clone(), window, cx));
		built = Some(settings.clone());
		let mut empty = || AnyView::from(cx.new(|_| EmptyView));
		let regions = Regions {
			sidebar:  empty(),
			thread:   empty(),
			panel:    empty(),
			drawer:   empty(),
			palette:  palette.into(),
			settings: settings.into(),
		};
		Workspace::new(view_state, regions, PanelsStore::default(), window, cx)
	});
	cx.simulate_resize(size(px(1200.0), px(800.0)));
	cx.run_until_parked();
	let settings = built.expect("the window built its regions");
	Win { state, settings, cx }
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

	/// Opens settings on `page` the way the palette and the menu do.
	pub fn open(&mut self, page: &str) {
		self
			.cx
			.dispatch_action(act::OpenSettings { page: Some(page.to_owned().into()) });
		self.cx.run_until_parked();
	}

	pub fn page(&self) -> Page {
		self
			.settings
			.read_with(&*self.cx, |settings, _| settings.page())
	}

	pub fn keys(&mut self, keys: &str) {
		self.cx.simulate_keystrokes(keys);
		self.cx.run_until_parked();
	}

	/// Focuses the input `settings.field:<key>` and replaces its text with
	/// `text`.
	pub fn type_into(&mut self, key: &str, text: &str) {
		self.click(&format!("settings.field:{key}"));
		self.keys("ctrl-a backspace");
		if !text.is_empty() {
			self.cx.simulate_input(text);
			self.cx.run_until_parked();
		}
	}

	/// Replaces the text of the input `settings.field:<key>` with `text` and
	/// presses Enter.
	pub fn submit(&mut self, key: &str, text: &str) {
		self.type_into(key, text);
		self.keys("enter");
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
}

/// The host's refusal of `request`, stated as `message` at `at` ms.
pub fn refused(request: RequestId, code: &str, message: &str, at: u64) -> HostEvent {
	HostEvent::RequestFailed {
		request,
		error: BackendError {
			scope:          ErrorScope::Settings,
			code:           Some(code.to_owned()),
			message:        message.to_owned(),
			retryable:      false,
			request:        Some(request),
			occurred_at_ms: at,
		},
	}
}

/// Seven settings on two tabs: `appearance` files `display.transitions` under
/// Motion, and `statusLine.preset` and the array `statusLine.segments` with
/// two declared choices under Status Line; `context` files the bounded
/// `compaction.threshold` and the hidden `argot.models` under Compaction, and
/// `retry.enabled`, set off against an on default, and the advanced
/// `retry.maxDelayMs` under Retry.
pub fn settings() -> HostEvent {
	let section: SettingsSection = serde_json::from_value(json!({
		"display.transitions": {
			"value": true, "default": true, "source": "default", "type": "boolean",
			"label": "Transitions", "tab": "appearance", "group": "Motion",
		},
		"statusLine.preset": {
			"value": "default", "default": "default", "source": "default", "type": "enum",
			"label": "Status line preset", "tab": "appearance", "group": "Status Line",
			"values": ["default", "minimal"],
		},
		"statusLine.segments": {
			"value": ["model"], "default": ["model"], "source": "default", "type": "array",
			"label": "Status line segments", "tab": "appearance", "group": "Status Line",
			"options": [{ "value": "model", "label": "Model" }, { "value": "cost", "label": "Cost" }],
		},
		"compaction.threshold": {
			"value": 80, "default": 80, "source": "default", "type": "number",
			"label": "Compaction threshold", "tab": "context", "group": "Compaction",
			"min": 0, "max": 100,
		},
		"retry.enabled": {
			"value": false, "default": true, "source": "profile", "type": "boolean",
			"label": "Retry failed requests", "tab": "context", "group": "Retry",
		},
		"retry.maxDelayMs": {
			"value": 30000, "default": 30000, "source": "default", "type": "number",
			"label": "Longest retry delay", "tab": "context", "group": "Retry",
			"description": "Milliseconds before the last attempt", "advanced": true,
		},
		"argot.models": {
			"value": [], "default": [], "source": "default", "type": "array",
			"label": "Argot models", "tab": "context", "group": "Compaction", "hidden": true,
		},
	}))
	.expect("the settings fixture decodes");
	HostEvent::Snapshot(SnapshotSection::Settings(section))
}

/// Anthropic signed in with one stored OAuth login, and one MCP server
/// `files`, connected and on, with the registry signed in.
pub fn accounts_and_servers() -> Vec<HostEvent> {
	vec![
		HostEvent::Snapshot(SnapshotSection::Providers(vec![ProviderView {
			id:            "anthropic".to_owned(),
			name:          "Anthropic".to_owned(),
			authenticated: true,
			oauth:         true,
			api_key:       true,
		}])),
		HostEvent::Snapshot(SnapshotSection::Accounts(vec![StoredAccountView {
			provider:      "anthropic".to_owned(),
			credential_id: 7,
			label:         "work@example.com".to_owned(),
			kind:          CredentialKind::Oauth,
			selected:      true,
		}])),
		HostEvent::Snapshot(SnapshotSection::Mcp(vec![McpServerView {
			name:    "files".to_owned(),
			enabled: true,
			status:  McpServerStatus::Connected,
			tools:   vec!["read".to_owned()],
		}])),
		HostEvent::Snapshot(SnapshotSection::McpRegistry(McpRegistryView {
			signed_in: true,
			query:     None,
			results:   Vec::new(),
		})),
	]
}
