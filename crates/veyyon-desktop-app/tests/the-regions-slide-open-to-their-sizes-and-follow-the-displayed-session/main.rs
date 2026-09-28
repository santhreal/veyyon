//! The workspace draws each region at the size it holds, slides a region open
//! and shut on a spring that reverses from where it is, lands at once under
//! reduced motion, and lays the regions out as each displayed session last
//! had them.
//!
//! WHY: a region drawn at a size other than the one the workspace holds
//! disagrees with its drag handle and with what is persisted. A slide that
//! restarts from an end jumps when toggled midway, and one that never rests
//! requests frames forever. Motion that ignores reduced motion animates for
//! an operator who turned it off. A closed region whose driver target
//! outlives it answers a driver client with the bounds of a region that is
//! gone. A layout that stays put across a session switch loses the layout
//! each session was left in.
//!
//! Gap: the spring's curve is the motion crate's contract, so a slide is
//! asserted by its bounds: a frame strictly between shut and open,
//! continuity at a reversal, and a rest within a frame budget. The sidebar
//! and drawer slide through the same `slot` as the panel and are asserted at
//! rest only.

use std::time::Duration;

use gpui::{
	AnyView, AppContext as _, Bounds, Context, Entity, IntoElement, Pixels, Render, TestAppContext,
	VisualTestContext, Window, div, prelude::*, px,
};
use veyyon_desktop_app::{
	AppState,
	actions::workspace as act,
	driver,
	workspace::{Regions, Workspace, WorkspaceEvent},
};
use veyyon_desktop_model::{PanelsStore, SessionId, Store};
use veyyon_desktop_ui::theme::{Appearance, Theme, size};

/// A region drawn as a box named by its selector.
struct Region(&'static str);

impl Render for Region {
	fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
		let name = self.0;
		div().debug_selector(move || name.to_owned()).size_full()
	}
}

fn session(id: &str) -> SessionId {
	SessionId::from(id.to_owned())
}

/// A workspace showing session `a`, laid out from its entry in `panels`.
fn open<'a>(
	cx: &'a mut TestAppContext,
	panels: &[(&str, PanelsStore)],
	reduce_motion: bool,
) -> (Entity<AppState>, Entity<Workspace>, &'a mut VisualTestContext) {
	driver::enable();
	cx.update(|cx| Theme::install(Appearance::Dark, cx))
		.expect("the dark palette parses");
	cx.update(|cx| cx.set_reduce_motion(reduce_motion));
	let mut store = Store::new();
	store.persisted.shell.active_session = Some(session("a"));
	for (id, layout) in panels {
		store.persisted.panels.insert(session(id), layout.clone());
	}
	let shown = store
		.persisted
		.panels
		.get(&session("a"))
		.cloned()
		.unwrap_or_default();
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
	cx.run_until_parked();
	(app, workspace, cx)
}

/// The bounds of driver target `id` in a frame drawn now, `None` when the
/// frame does not draw it. A region closed at rest must not answer with the
/// sliver its last moving frame drew.
fn target(cx: &mut VisualTestContext, id: &str) -> Option<Bounds<Pixels>> {
	cx.update(|window, _| window.refresh());
	cx.run_until_parked();
	cx.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
}

fn width(cx: &mut VisualTestContext, id: &str) -> Option<Pixels> {
	target(cx, id).map(|bounds| bounds.size.width)
}

/// Moves the clock `by` and delivers the frame the window asked for.
/// Returns whether it asked for one.
fn frame(cx: &mut VisualTestContext, by: Duration) -> bool {
	cx.executor().advance_clock(by);
	let asked = cx.update(|window, cx| window.simulate_next_frame(cx)) > 0;
	cx.run_until_parked();
	asked
}

/// Delivers frames until the window stops asking for them.
fn rest(cx: &mut VisualTestContext) {
	for _ in 0..240 {
		if !frame(cx, Duration::from_millis(16)) {
			return;
		}
	}
	panic!("the window still asks for frames four seconds after a toggle");
}

fn dispatch(cx: &mut VisualTestContext, action: impl gpui::Action) {
	cx.update(|window, cx| window.dispatch_action(Box::new(action), cx));
	cx.run_until_parked();
}

fn panel_open_at(width: u32) -> PanelsStore {
	PanelsStore {
		right_panel_visible: true,
		right_panel_width: Some(width),
		..PanelsStore::default()
	}
}

/// Displays session `id`, as a click on its sidebar row does.
fn show(app: &Entity<AppState>, cx: &mut VisualTestContext, id: &str) {
	app.update(cx, |app, cx| {
		app.open_session(session(id), cx);
	});
	cx.run_until_parked();
}

#[test]
fn each_region_is_drawn_at_its_size_and_the_thread_takes_the_rest() {
	let mut cx = TestAppContext::single();
	let stored =
		PanelsStore { drawer_visible: true, drawer_height: Some(200), ..panel_open_at(600) };
	let (_, _, cx) = open(&mut cx, &[("a", stored)], true);
	let viewport = cx.update(|window, _| window.viewport_size());
	let sidebar = target(cx, "sidebar").expect("the sidebar is drawn");
	let panel = target(cx, "panel").expect("the panel is drawn");
	let drawer = target(cx, "drawer").expect("the drawer is drawn");
	cx.update(|window, _| window.refresh());
	let thread = cx
		.debug_bounds("thread-region")
		.expect("the thread is drawn");

	assert_eq!((sidebar.origin.x, sidebar.size.width), (px(0.), size::SIDEBAR));
	assert_eq!((panel.right(), panel.size.width), (viewport.width, px(600.)));
	assert_eq!((drawer.bottom(), drawer.size.height), (viewport.height, px(200.)));
	assert!(thread.left() >= sidebar.right() && thread.right() <= panel.left());
	assert!(thread.bottom() <= drawer.top() && drawer.left() >= sidebar.right());
	let handles = size::RESIZE_HANDLE * 2.;
	assert!(
		thread.size.width >= viewport.width - size::SIDEBAR - px(600.) - handles,
		"the thread takes the width the side regions leave: {thread:?} in {viewport:?}"
	);
}

#[test]
fn a_toggled_region_slides_reverses_from_where_it_is_and_comes_to_rest() {
	let mut cx = TestAppContext::single();
	let (_, _, cx) = open(&mut cx, &[("a", panel_open_at(600))], false);
	let full = px(600.);
	assert_eq!(width(cx, "panel"), Some(full));

	dispatch(cx, act::TogglePanel);
	assert!(frame(cx, Duration::from_millis(48)), "a closing panel asks for frames");
	let closing = width(cx, "panel").expect("a closing panel is drawn");
	assert!(closing > px(0.) && closing < full, "the panel is between open and shut: {closing:?}");

	dispatch(cx, act::TogglePanel);
	frame(cx, Duration::from_millis(16));
	let reversed = width(cx, "panel").expect("a reopening panel is drawn");
	assert!(
		(reversed - closing).abs() < full * 0.25,
		"the reversal starts where the panel was, not at an end: {closing:?} then {reversed:?}"
	);
	rest(cx);
	assert_eq!(width(cx, "panel"), Some(full), "the reopened panel rests at its size");

	dispatch(cx, act::TogglePanel);
	rest(cx);
	assert_eq!(width(cx, "panel"), None, "a shut panel at rest is not drawn");
	assert!(!frame(cx, Duration::from_millis(16)), "a window at rest asks for no frame");
}

#[test]
fn under_reduced_motion_a_toggled_region_lands_on_the_next_frame() {
	let mut cx = TestAppContext::single();
	let (_, _, cx) = open(&mut cx, &[], true);
	assert_eq!(width(cx, "panel"), None);
	dispatch(cx, act::TogglePanel);
	assert_eq!(width(cx, "panel"), Some(size::PANEL), "open at its default size at once");
	assert!(!frame(cx, Duration::from_millis(16)), "no frame is asked for after it lands");
	dispatch(cx, act::ToggleDrawer);
	assert_eq!(target(cx, "drawer").map(|drawer| drawer.size.height), Some(size::DRAWER));
}

#[test]
fn each_displayed_session_is_laid_out_as_it_was_left() {
	let mut cx = TestAppContext::single();
	let b = PanelsStore { drawer_visible: true, drawer_height: Some(200), ..PanelsStore::default() };
	let (app, workspace, cx) = open(&mut cx, &[("a", panel_open_at(600)), ("b", b.clone())], true);
	assert_eq!((width(cx, "panel"), target(cx, "drawer")), (Some(px(600.)), None));

	show(&app, cx, "b");
	assert_eq!(width(cx, "panel"), None, "b was left with the panel shut");
	assert_eq!(target(cx, "drawer").map(|drawer| drawer.size.height), Some(px(200.)));
	let reported = workspace.read_with(cx, |workspace, cx| workspace.panels_store(cx));
	assert_eq!(
		(reported.right_panel_visible, reported.drawer_visible, reported.drawer_height),
		(b.right_panel_visible, b.drawer_visible, b.drawer_height)
	);

	show(&app, cx, "a");
	assert_eq!((width(cx, "panel"), target(cx, "drawer")), (Some(px(600.)), None));

	show(&app, cx, "c");
	assert_eq!(
		(width(cx, "panel"), target(cx, "drawer")),
		(Some(px(600.)), None),
		"a session with no layout of its own keeps the one on screen"
	);
}

#[test]
fn a_layout_changed_in_a_session_is_the_one_it_reopens_with() {
	let mut cx = TestAppContext::single();
	let (app, workspace, cx) =
		open(&mut cx, &[("a", panel_open_at(600)), ("b", PanelsStore::default())], true);
	// The window's owner records each reported layout, as the binary does.
	let recorder = app.clone();
	cx.update(|_, cx| {
		cx.subscribe(&workspace, move |_, event: &WorkspaceEvent, cx| {
			let WorkspaceEvent::LayoutChanged(layout) = event;
			recorder.update(cx, |app, _| app.record_layout(layout));
		})
		.detach();
	});

	dispatch(cx, act::TogglePanel);
	dispatch(cx, act::ToggleDrawer);
	show(&app, cx, "b");
	assert_eq!((width(cx, "panel"), target(cx, "drawer")), (None, None));
	show(&app, cx, "a");
	assert_eq!(width(cx, "panel"), None, "a reopens with the panel it closed");
	assert_eq!(target(cx, "drawer").map(|drawer| drawer.size.height), Some(size::DRAWER));

	let stored =
		app.read_with(cx, |app, _| app.store().persisted.panels.get(&session("a")).cloned());
	let stored = stored.expect("a's layout is persisted");
	assert_eq!(
		(stored.right_panel_visible, stored.right_panel_width, stored.drawer_visible),
		(false, Some(600), true),
		"the closed panel keeps the width it was dragged to"
	);
}
