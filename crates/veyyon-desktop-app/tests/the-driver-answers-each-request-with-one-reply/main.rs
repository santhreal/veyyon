//! A driver client's request line gets one reply line, in the bytes the bench
//! and the scene scripts parse, and a `wait` is answered only once its
//! condition holds in a painted frame.
//!
//! WHY: the driver is the only way a scene script or the bench acts on a real
//! window. A reply in the wrong shape, a wait answered before the frame that
//! satisfies it, or a wait kept for a client that hung up turns every capture
//! and every latency number taken through it into noise.
//!
//! Gap: requests go through the in-process [`Client`], so the socket's own
//! threads are covered by the unit tests in `driver/socket.rs`, not here. The
//! test platform presents no frame, so a window here never goes idle and an
//! `idle` wait is only seen parked, never answered.

use gpui::{
	AnyView, AnyWindowHandle, AppContext as _, Context, EmptyView, Entity, IntoElement, KeyBinding,
	ParentElement, Render, SharedString, Styled, TestAppContext, Window, div,
};
use serde_json::{Value, json};
use veyyon_desktop_app::{
	AppState,
	actions::workspace as act,
	driver::{Client, waiting},
	workspace::{Regions, Workspace, WorkspaceLayout},
};
use veyyon_desktop_model::{PanelsStore, Store};
use veyyon_desktop_ui::theme::{Appearance, Theme, size};

/// The sidebar region of the driven window: one line of text.
struct Words(SharedString);

impl Render for Words {
	fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
		div().size_full().p_2().child(self.0.clone())
	}
}

/// A window driven through a client connected before it opened. `cx` is
/// the last field so the handles drop before the app checks for leaks.
struct Driven {
	client: Client,
	window: AnyWindowHandle,
	words:  Entity<Words>,
	cx:     TestAppContext,
}

impl Driven {
	fn open() -> Self {
		let mut cx = TestAppContext::single();
		cx.update(|cx| Theme::install(Appearance::Dark, cx))
			.expect("the dark palette parses");
		let client = cx.update(Client::connect);
		let app = cx.update(|cx| cx.new(|_| AppState::new(Store::new())));
		let words = cx.update(|cx| cx.new(|_| Words(SharedString::default())));
		let sidebar = AnyView::from(words.clone());
		let window = cx.add_window(move |window, cx| {
			let mut empty = || AnyView::from(cx.new(|_| EmptyView));
			let regions = Regions {
				sidebar,
				thread: empty(),
				panel: empty(),
				drawer: empty(),
				palette: empty(),
				settings: empty(),
			};
			Workspace::new(app, regions, PanelsStore::default(), window, cx)
		});
		cx.run_until_parked();
		Self { cx, client, window: window.into(), words }
	}

	/// Sends `line` and returns the reply, if one came.
	fn ask(&self, line: &str) -> Option<String> {
		send(&self.cx, &self.client, line)
	}

	/// Draws `text` in the sidebar and lets the window paint it.
	fn show(&self, text: &'static str) {
		self.cx.update(|cx| {
			self.words.update(cx, |words, cx| {
				words.0 = text.into();
				cx.notify();
			});
		});
		self.cx.run_until_parked();
	}

	fn layout(&self) -> WorkspaceLayout {
		self.cx.update(|cx| WorkspaceLayout::get(cx).clone())
	}

	fn waiting(&self) -> usize {
		self.cx.update(|cx| waiting(cx))
	}
}

fn send(cx: &TestAppContext, client: &Client, line: &str) -> Option<String> {
	cx.update(|cx| client.send(line, cx));
	cx.run_until_parked();
	client.next_line()
}

fn parse(line: &str) -> Value {
	serde_json::from_str(line).unwrap_or_else(|error| panic!("`{line}` is JSON: {error}"))
}

#[test]
fn a_request_that_does_not_parse_is_answered_with_what_is_wrong_and_its_id() {
	let driven = Driven::open();
	let cases = [
		("[1]", r#"{"id":null,"error":"a request is a JSON object"}"#),
		(
			r#"{"id":3}"#,
			r#"{"id":3,"error":"a request holds one of `dispatch`, `type`, `bounds`, `subscribe`, `wait`"}"#,
		),
		(r#"{"id":4,"dispatch":7}"#, r#"{"id":4,"error":"`dispatch` names an action as a string"}"#),
		(r#"{"id":5,"type":[]}"#, r#"{"id":5,"error":"`type` holds the text to type as a string"}"#),
		(r#"{"id":6,"bounds":null}"#, r#"{"id":6,"error":"`bounds` names a target as a string"}"#),
		(r#"{"id":7,"subscribe":"keys"}"#, r#"{"id":7,"error":"`subscribe` accepts \"frames\""}"#),
		(r#"{"id":8,"wait":"forever"}"#, r#"{"id":8,"error":"`wait` accepts \"idle\" or \"text\""}"#),
		(
			r#"{"id":9,"wait":"text","target":"sidebar"}"#,
			r#"{"id":9,"error":"`wait: \"text\"` holds `contains` as a string"}"#,
		),
		(
			r#"{"id":"x","dispatch":"workspace::Nope"}"#,
			r#"{"id":"x","error":"no action is registered as `workspace::Nope`"}"#,
		),
		(r#"{"id":10,"bounds":"nowhere"}"#, r#"{"id":10,"error":"no target `nowhere` is laid out"}"#),
	];
	for (line, reply) in cases {
		assert_eq!(driven.ask(line).as_deref(), Some(reply), "for {line}");
	}
	let reply = driven.ask("not json").unwrap_or_default();
	assert!(reply.starts_with(r#"{"id":null,"error":"the request is not JSON: "#), "{reply}");
	let reply = driven
		.ask(r#"{"id":11,"dispatch":"workspace::ShowPanelTab","args":{"tab":5}}"#)
		.unwrap_or_default();
	assert!(
		reply.starts_with(
			r#"{"id":11,"error":"`workspace::ShowPanelTab` cannot be built from `args`: "#
		),
		"{reply}"
	);
	assert_eq!(driven.client.next_line(), None, "one reply per request");
	assert_eq!(driven.layout(), WorkspaceLayout::default(), "a refused request changes nothing");
}

#[test]
fn a_request_with_no_window_open_is_refused() {
	let cx = TestAppContext::single();
	let client = cx.update(Client::connect);
	for (id, request) in [
		(1, r#""dispatch":"workspace::ToggleDrawer""#),
		(2, r#""type":"a""#),
		(3, r#""bounds":"sidebar""#),
		(4, r#""wait":"idle""#),
		(5, r#""wait":"text","target":"sidebar","contains":"a""#),
	] {
		let reply = send(&cx, &client, &format!(r#"{{"id":{id},{request}}}"#));
		assert_eq!(reply, Some(format!(r#"{{"id":{id},"error":"no window is open"}}"#)));
	}
	assert_eq!(cx.update(|cx| waiting(cx)), 0);
}

#[test]
fn dispatch_builds_the_action_from_its_args_and_runs_it_before_the_reply() {
	let driven = Driven::open();
	let reply =
		driven.ask(r#"{"id":1,"dispatch":"workspace::ShowPanelTab","args":{"tab":"agents"}}"#);
	assert_eq!(reply.as_deref(), Some(r#"{"id":1,"ok":true}"#));
	let reply = driven.ask(r#"{"id":"b","dispatch":"workspace::ToggleDrawer"}"#);
	assert_eq!(reply.as_deref(), Some(r#"{"id":"b","ok":true}"#));
	let expected = WorkspaceLayout {
		panel_open: true,
		panel_tab: "agents".into(),
		drawer_open: true,
		..WorkspaceLayout::default()
	};
	assert_eq!(driven.layout(), expected);
}

#[test]
fn type_sends_each_character_as_the_keystroke_a_keyboard_would() {
	let driven = Driven::open();
	driven.cx.update(|cx| {
		cx.bind_keys([
			KeyBinding::new("t", act::ToggleDrawer, Some("Workspace")),
			KeyBinding::new("shift-t", act::TogglePanel, Some("Workspace")),
			KeyBinding::new("space", act::ToggleSidebar, Some("Workspace")),
		]);
	});
	assert_eq!(driven.ask(r#"{"id":1,"type":"tT "}"#).as_deref(), Some(r#"{"id":1,"ok":true}"#));
	let expected = WorkspaceLayout {
		drawer_open: true,
		panel_open: true,
		sidebar_visible: false,
		..WorkspaceLayout::default()
	};
	assert_eq!(driven.layout(), expected);
}

#[test]
fn bounds_reports_where_a_target_was_laid_out_in_window_pixels() {
	let driven = Driven::open();
	let viewport = driven
		.cx
		.update(|cx| {
			driven
				.window
				.update(cx, |_, window, _| window.viewport_size())
		})
		.unwrap_or_else(|error| panic!("the window is open: {error}"));
	let reply = driven
		.ask(r#"{"id":1,"bounds":"sidebar"}"#)
		.unwrap_or_default();
	let expected = json!({
		"id": 1,
		"bounds": {
			"x": 0.0,
			"y": 0.0,
			"w": f32::from(size::SIDEBAR),
			"h": f32::from(viewport.height),
		},
	});
	assert_eq!(parse(&reply), expected);
}

#[test]
fn a_frame_subscription_reports_each_painted_frame_once_in_order() {
	let driven = Driven::open();
	assert_eq!(
		driven.ask(r#"{"id":1,"subscribe":"frames"}"#).as_deref(),
		Some(r#"{"id":1,"ok":true}"#)
	);
	assert_eq!(driven.client.next_line(), None, "no frame is painted at rest");
	let mut frames = Vec::new();
	for text in ["one", "two", "three"] {
		driven.show(text);
		let event = parse(&driven.client.next_line().unwrap_or_default());
		assert_eq!(event["event"], "frame", "{event}");
		frames.push((event["n"].as_u64(), event["t_ns"].as_u64()));
		assert_eq!(driven.client.next_line(), None, "one event per painted frame");
	}
	let counts: Vec<_> = frames.iter().map(|(n, _)| n.unwrap_or(0)).collect();
	assert_eq!(counts, [counts[0], counts[0] + 1, counts[0] + 2]);
	let stamps: Vec<_> = frames.iter().map(|(_, t)| t.unwrap_or(0)).collect();
	assert!(stamps[0] > 0 && stamps.is_sorted(), "{stamps:?}");
}

#[test]
fn a_text_wait_is_answered_by_the_frame_that_paints_the_text_in_its_target() {
	let driven = Driven::open();
	driven.show("nothing yet");
	let wait = r#"{"id":1,"wait":"text","target":"sidebar","contains":"hello"}"#;
	assert_eq!(driven.ask(wait), None, "the text is not drawn yet");
	assert_eq!(driven.waiting(), 1);
	driven.show("still nothing");
	assert_eq!(driven.client.next_line(), None, "a frame without the text answers nothing");
	driven.show("say hello");
	assert_eq!(driven.client.next_line().as_deref(), Some(r#"{"id":1,"ok":true}"#));
	assert_eq!(driven.waiting(), 0);

	let drawn = r#"{"id":2,"wait":"text","target":"sidebar","contains":"say hello"}"#;
	assert_eq!(
		driven.ask(drawn).as_deref(),
		Some(r#"{"id":2,"ok":true}"#),
		"drawn text answers at once"
	);
	let elsewhere = r#"{"id":3,"wait":"text","target":"panel","contains":"say hello"}"#;
	assert_eq!(driven.ask(elsewhere), None, "a target not laid out waits");
	assert_eq!(driven.waiting(), 1);
}

#[test]
fn an_idle_wait_parks_while_the_window_has_a_frame_to_present() {
	let driven = Driven::open();
	assert_eq!(driven.ask(r#"{"id":1,"wait":"idle"}"#), None);
	driven.show("a frame");
	assert_eq!(driven.client.next_line(), None);
	assert_eq!(driven.waiting(), 1);
}

#[test]
fn the_waits_of_a_client_that_hung_up_are_dropped_after_the_next_frame() {
	let driven = Driven::open();
	let other = driven.cx.update(Client::connect);
	assert_eq!(driven.ask(r#"{"id":1,"wait":"idle"}"#), None);
	let text = r#"{"id":2,"wait":"text","target":"sidebar","contains":"never"}"#;
	assert_eq!(send(&driven.cx, &other, text), None);
	assert_eq!(send(&driven.cx, &other, r#"{"id":3,"wait":"idle"}"#), None);
	assert_eq!(driven.waiting(), 3);
	drop(other);
	driven.show("a frame");
	assert_eq!(driven.waiting(), 1, "only the connected client's wait is left");
	assert_eq!(driven.client.next_line(), None);
}
