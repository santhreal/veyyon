//! The regions are laid out for the session the host's answer settles on.

use std::time::Duration;

use gpui::{
	AnyView, AppContext as _, Bounds, Context, Entity, IntoElement, Pixels, Render, TestAppContext,
	VisualTestContext, Window, div, prelude::*, px,
};
use veyyon_desktop_app::{
	AppState,
	actions::workspace as act,
	driver,
	state::REQUEST_TIMEOUT_MS,
	workspace::{Regions, Workspace, WorkspaceEvent},
};
use veyyon_desktop_model::{
	HostAction, HostEvent, PanelsStore, RequestId, SessionId, Store, SurfaceId,
};
use veyyon_desktop_ui::theme::{Appearance, Theme, size};

use super::{refused, sid};

/// A region drawn as a box named by its selector.
struct Region(&'static str);

impl Render for Region {
	fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
		let name = self.0;
		div().debug_selector(move || name.to_owned()).size_full()
	}
}

/// `a` with the panel open at 600, `b` with the drawer open at 200.
fn layouts() -> [(&'static str, PanelsStore); 2] {
	let a = PanelsStore {
		right_panel_visible: true,
		right_panel_width: Some(600),
		..PanelsStore::default()
	};
	let b = PanelsStore { drawer_visible: true, drawer_height: Some(200), ..PanelsStore::default() };
	[("a", a), ("b", b)]
}

/// A workspace showing `a`, the host's active session, with each session
/// laid out from [`layouts`], whose owner records each reported layout as the
/// binary does.
fn open(cx: &mut TestAppContext) -> (Entity<AppState>, &mut VisualTestContext) {
	driver::enable();
	cx.update(|cx| Theme::install(Appearance::Dark, cx))
		.expect("the dark palette parses");
	cx.update(|cx| cx.set_reduce_motion(true));
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(sid("a"));
	for (id, layout) in layouts() {
		store.persisted.panels.insert(sid(id), layout);
	}
	let shown = layouts()[0].1.clone();
	let app = cx.update(|cx| cx.new(|_| AppState::new(store)));
	let state = app.clone();
	let (workspace, cx) = cx.add_window_view(move |window, cx| {
		let palette = AnyView::from(cx.new(|_| gpui::EmptyView));
		let mut region = |name| AnyView::from(cx.new(|_| Region(name)));
		let regions = Regions {
			sidebar: region("sidebar-region"),
			thread: region("thread-region"),
			panel: region("panel-region"),
			drawer: region("drawer-region"),
			palette,
			settings: region("settings-region"),
		};
		Workspace::new(state, regions, shown, window, cx)
	});
	let recorder = app.clone();
	cx.update(|_, cx| {
		cx.subscribe(&workspace, move |_, event: &WorkspaceEvent, cx| {
			let WorkspaceEvent::LayoutChanged(layout) = event;
			recorder.update(cx, |app, cx| app.record_layout(layout, cx));
		})
		.detach();
	});
	cx.run_until_parked();
	(app, cx)
}

/// The bounds of driver target `id` in a frame drawn now, `None` when the
/// frame does not draw it.
fn target(cx: &mut VisualTestContext, id: &str) -> Option<Bounds<Pixels>> {
	cx.update(|window, _| window.refresh());
	cx.run_until_parked();
	cx.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
}

/// The panel's width and the drawer's height as drawn, `None` for a region
/// the frame does not draw.
fn drawn(cx: &mut VisualTestContext) -> (Option<Pixels>, Option<Pixels>) {
	let panel = target(cx, "panel").map(|bounds| bounds.size.width);
	let drawer = target(cx, "drawer").map(|bounds| bounds.size.height);
	(panel, drawer)
}

/// `a`'s layout as drawn: the panel at 600 and no drawer.
const fn a_drawn() -> (Option<Pixels>, Option<Pixels>) {
	(Some(px(600.)), None)
}

/// `b`'s layout as drawn: no panel and the drawer at 200.
const fn b_drawn() -> (Option<Pixels>, Option<Pixels>) {
	(None, Some(px(200.)))
}

fn open_session(app: &Entity<AppState>, cx: &mut VisualTestContext, id: &str) -> RequestId {
	let request = app.update(cx, |app, cx| app.open_session(sid(id), cx));
	cx.run_until_parked();
	request
}

fn apply(app: &Entity<AppState>, cx: &mut VisualTestContext, events: Vec<HostEvent>) {
	app.update(cx, |app, cx| app.apply(events, cx));
	cx.run_until_parked();
}

fn shown(app: &Entity<AppState>, cx: &VisualTestContext) -> Option<SessionId> {
	app.read_with(cx, |app, _| app.active_session().cloned())
}

#[test]
fn a_refused_open_lays_the_regions_out_as_the_hosts_session_again() {
	let mut cx = TestAppContext::single();
	let (app, cx) = open(&mut cx);
	assert_eq!(drawn(cx), a_drawn());

	let request = open_session(&app, cx, "b");
	assert_eq!(drawn(cx), b_drawn(), "the window shows `b` before the host answers");
	apply(&app, cx, vec![refused(request)]);
	assert_eq!(shown(&app, cx), Some(sid("a")));
	assert_eq!(drawn(cx), a_drawn(), "the refused session's layout is not kept");
}

#[test]
fn an_answer_to_another_request_leaves_the_opening_sessions_layout() {
	let mut cx = TestAppContext::single();
	let (app, cx) = open(&mut cx);
	let request = open_session(&app, cx, "b");
	let [refresh, other] =
		[HostAction::RefreshProcesses, HostAction::RefreshChanges].map(|action| {
			app.update(cx, |app, cx| app.dispatch(action, SurfaceId::GlobalTitlebarLine, cx))
		});
	assert!(refresh != request && other != request);

	apply(&app, cx, vec![
		refused(refresh),
		HostEvent::RequestSucceeded { request: other },
		refused(RequestId(request.0 + 100)),
	]);
	assert_eq!(shown(&app, cx), Some(sid("b")), "`b`'s open is still in flight");
	assert_eq!(drawn(cx), b_drawn());

	apply(&app, cx, vec![refused(request)]);
	assert_eq!(drawn(cx), a_drawn(), "the open's own refusal settles it");
}

#[test]
fn an_open_the_host_leaves_unanswered_returns_the_regions_at_its_deadline_for_good() {
	let mut cx = TestAppContext::single();
	let (app, cx) = open(&mut cx);
	let request = open_session(&app, cx, "b");

	cx.executor()
		.advance_clock(Duration::from_millis(REQUEST_TIMEOUT_MS / 2));
	cx.run_until_parked();
	assert_eq!(drawn(cx), b_drawn(), "the deadline has not passed");
	cx.executor()
		.advance_clock(Duration::from_millis(REQUEST_TIMEOUT_MS));
	cx.run_until_parked();
	assert_eq!(shown(&app, cx), Some(sid("a")));
	assert_eq!(drawn(cx), a_drawn());

	apply(&app, cx, vec![HostEvent::RequestSucceeded { request }]);
	assert_eq!(shown(&app, cx), Some(sid("a")), "a success after the deadline changes nothing");
	assert_eq!(drawn(cx), a_drawn());
}

#[test]
fn a_refused_open_returns_to_the_layout_the_departing_session_was_left_in() {
	let mut cx = TestAppContext::single();
	let (app, cx) = open(&mut cx);
	cx.update(|window, cx| window.dispatch_action(Box::new(act::TogglePanel), cx));
	cx.run_until_parked();
	cx.update(|window, cx| window.dispatch_action(Box::new(act::ToggleDrawer), cx));
	cx.run_until_parked();
	let left = (None, Some(size::DRAWER));
	assert_eq!(drawn(cx), left);

	let request = open_session(&app, cx, "b");
	assert_eq!(drawn(cx), b_drawn());
	apply(&app, cx, vec![refused(request)]);
	assert_eq!(drawn(cx), left, "`a` returns as it was left, not as it was stored before");
}
