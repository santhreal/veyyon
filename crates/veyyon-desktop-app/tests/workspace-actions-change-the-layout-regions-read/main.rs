//! The `workspace` actions change the layout global every region reads,
//! region sizes stay within their bounds and round-trip through the panels
//! store, and the connection actions queue the host request of their control.
//!
//! WHY: a region talks to the workspace only through these actions and the
//! layout global, so an action the workspace does not answer is a dead key
//! and a dead palette row. A size stored out of range, or a size never
//! dragged written as a number, pins a region wrongly on the next launch.
//!
//! Gap: the slide is checked only for where it lands; spring positions frame
//! by frame are the motion crate's contract. Focus moves need registered
//! regions and are not covered here.

use gpui::{
	AnyView, AnyWindowHandle, AppContext as _, EmptyView, TestAppContext, WindowHandle, px,
};
use veyyon_desktop_app::{
	AppState,
	actions::workspace as act,
	workspace::{Regions, Sizes, Workspace, WorkspaceLayout},
};
use veyyon_desktop_model::{HostAction, PanelsStore, Store};
use veyyon_desktop_ui::theme::{Appearance, Theme, size};

/// A window laid out from `store` with empty regions.
fn open(
	cx: &mut TestAppContext,
	store: PanelsStore,
) -> (WindowHandle<Workspace>, gpui::Entity<AppState>) {
	cx.update(|cx| Theme::install(Appearance::Dark, cx)).expect("the dark palette parses");
	let app = cx.update(|cx| cx.new(|_| AppState::new(Store::new())));
	let state = app.clone();
	let window = cx.add_window(move |window, cx| {
		let mut empty = || AnyView::from(cx.new(|_| EmptyView));
		let regions = Regions {
			sidebar:  empty(),
			thread:   empty(),
			panel:    empty(),
			drawer:   empty(),
			palette:  empty(),
			settings: empty(),
		};
		Workspace::new(state, regions, store, window, cx)
	});
	cx.run_until_parked();
	(window, app)
}

/// An action and the layout change it makes.
type Step = (Box<dyn gpui::Action>, fn(&mut WorkspaceLayout));

fn step(action: impl gpui::Action, change: fn(&mut WorkspaceLayout)) -> Step {
	(Box::new(action), change)
}

fn layout(cx: &TestAppContext) -> WorkspaceLayout {
	cx.update(|cx| WorkspaceLayout::get(cx).clone())
}

fn sizes(cx: &mut TestAppContext, window: WindowHandle<Workspace>) -> Sizes {
	cx.update(|cx| window.update(cx, |workspace, _, _| workspace.sizes()))
		.unwrap_or_else(|error| panic!("the window is open: {error}"))
}

#[test]
fn each_layout_action_changes_only_its_own_field() {
	let mut cx = TestAppContext::single();
	let (window, _) = open(&mut cx, PanelsStore::default());
	let any: AnyWindowHandle = window.into();
	let mut expected = WorkspaceLayout::default();
	assert_eq!(layout(&cx), expected);

	let steps = [
		step(act::ToggleSidebar, |l| l.sidebar_visible = false),
		step(act::TogglePanel, |l| l.panel_open = true),
		step(act::ToggleDrawer, |l| l.drawer_open = true),
		step(act::ShowPanelTab { tab: "agents".into() }, |l| l.panel_tab = "agents".into()),
		step(act::TogglePanel, |l| l.panel_open = false),
		step(act::ShowPanelTab { tab: "todo".into() }, |l| {
			l.panel_tab = "todo".into();
			l.panel_open = true;
		}),
		step(act::OpenPalette, |l| l.palette_open = true),
		step(act::OpenSettings { page: Some("models".into()) }, |l| {
			l.settings_open = true;
			l.settings_page = Some("models".into());
			l.palette_open = false;
		}),
		step(act::CloseSettings, |l| {
			l.settings_open = false;
			l.settings_page = None;
		}),
		step(act::TogglePalette, |l| l.palette_open = true),
		step(act::ClosePalette, |l| l.palette_open = false),
		step(act::SearchThreads, |l| l.sidebar_visible = true),
	];
	for (action, change) in steps {
		let name = action.name();
		cx.update(|cx| any.update(cx, |_, window, cx| window.dispatch_action(action, cx)))
			.unwrap_or_else(|error| panic!("the window is open: {error}"));
		cx.run_until_parked();
		change(&mut expected);
		assert_eq!(layout(&cx), expected, "after {name}");
	}
}

#[test]
fn connection_actions_queue_the_request_their_control_sends() {
	let mut cx = TestAppContext::single();
	let (window, app) = open(&mut cx, PanelsStore::default());
	let any: AnyWindowHandle = window.into();
	let actions: [Box<dyn gpui::Action>; 5] = [
		Box::new(act::Attach),
		Box::new(act::Detach),
		Box::new(act::RetryConnection),
		Box::new(act::Shutdown),
		Box::new(act::NewThread),
	];
	for action in actions {
		cx.update(|cx| any.update(cx, |_, window, cx| window.dispatch_action(action, cx)))
			.unwrap_or_else(|error| panic!("the window is open: {error}"));
	}
	let sent: Vec<HostAction> = cx
		.update(|cx| app.update(cx, |app, _| app.drain_outbox()))
		.into_iter()
		.map(|request| request.action)
		.collect();
	assert_eq!(sent, [
		HostAction::Attach { endpoint: None },
		HostAction::Detach,
		HostAction::RetryConnection,
		HostAction::Shutdown,
		HostAction::CreateSession { workspace: None, title: None },
	]);
}

#[test]
fn a_drag_stays_within_the_region_bounds() {
	let mut sizes = Sizes::default();
	sizes.drag_sidebar(px(10_000.0));
	sizes.drag_panel(px(10_000.0));
	sizes.drag_drawer(px(10_000.0), px(1000.0));
	assert_eq!(
		(sizes.sidebar, sizes.panel, sizes.drawer),
		(size::SIDEBAR_MAX, size::PANEL_MAX, px(1000.0) * 0.7)
	);
	sizes.drag_sidebar(px(-10_000.0));
	sizes.drag_panel(px(-10_000.0));
	sizes.drag_drawer(px(-10_000.0), px(1000.0));
	assert_eq!(
		(sizes.sidebar, sizes.panel, sizes.drawer),
		(size::SIDEBAR_MIN, size::PANEL_MIN, size::DRAWER_MIN)
	);
}

#[test]
fn a_size_never_dragged_is_stored_absent_and_a_dragged_one_round_trips() {
	let layout = WorkspaceLayout::default();
	let mut store = PanelsStore::default();
	Sizes::default().record(&layout, &mut store);
	assert_eq!(
		(store.queue_width, store.right_panel_width, store.drawer_height),
		(None, None, None)
	);

	let mut sizes = Sizes::default();
	sizes.drag_panel(px(100.0));
	sizes.drag_drawer(px(20.0), px(1000.0));
	sizes.record(&layout, &mut store);
	assert_eq!(
		(store.queue_width, store.right_panel_width, store.drawer_height),
		(None, Some(580), Some(300))
	);
	let mut restored_layout = WorkspaceLayout::default();
	assert_eq!(Sizes::restore(&store, &mut restored_layout), sizes);
}

#[test]
fn an_out_of_range_stored_size_is_clamped_and_the_window_opens_as_stored() {
	let mut cx = TestAppContext::single();
	let store = PanelsStore {
		right_panel_visible: true,
		right_panel_width: Some(5000),
		queue_width: Some(10),
		drawer_visible: true,
		active_right_tab: Some("diagnostics".into()),
		..PanelsStore::default()
	};
	let (window, _) = open(&mut cx, store);
	let opened = layout(&cx);
	assert!(opened.panel_open && opened.drawer_open);
	assert_eq!(opened.panel_tab, "diagnostics");
	let sizes = sizes(&mut cx, window);
	assert_eq!(
		(sizes.sidebar, sizes.panel, sizes.drawer),
		(size::SIDEBAR_MIN, size::PANEL_MAX, size::DRAWER)
	);

	let any: AnyWindowHandle = window.into();
	cx.update(|cx| {
		any.update(cx, |_, window, cx| window.dispatch_action(Box::new(act::ResetLayout), cx))
	})
		.unwrap_or_else(|error| panic!("the window is open: {error}"));
	assert_eq!(sizes_after_reset(&mut cx, window), Sizes::default());
}

fn sizes_after_reset(cx: &mut TestAppContext, window: WindowHandle<Workspace>) -> Sizes {
	cx.run_until_parked();
	sizes(cx, window)
}
