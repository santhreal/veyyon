//! A region that closes while it holds focus hands the keys back: to the
//! composer while the thread is drawn, else to the workspace, and the keys
//! that closed the region open it again.
//!
//! WHY: a focused node the frame no longer draws dispatches every key and
//! action from the window's root, above the workspace's listeners. After a
//! focused sidebar, panel, drawer, settings or palette closes, no toggle
//! reaches the workspace and the window stops answering its keys. Focus sent
//! to a composer that is registered but not drawn (no session open, or the
//! settings in the thread's place) strands the keys the same way.
//!
//! Gap: the sweep names the closable regions by the actions that close them.
//! A new `Regions` field fails to compile here until it is added, but a new
//! way to hide a region through some other action is not swept. A focused
//! node that leaves a region still drawn takes the same `on_focus_lost` path
//! and has no case of its own.

use std::collections::HashMap;

use gpui::{
	Action, AnyView, AppContext as _, Context, Entity, FocusHandle, Focusable, IntoElement, Render,
	Subscription, TestAppContext, VisualTestContext, Window, div, prelude::*,
};
use veyyon_desktop_app::{
	AppState,
	actions::workspace as act,
	workspace::{self, FocusSlot, Regions, Workspace, WorkspaceLayout, register_focus},
};
use veyyon_desktop_model::{PanelsStore, SessionId, Store};
use veyyon_desktop_ui::theme::{Appearance, Theme};

const REGIONS: [&str; 6] = [
	"sidebar-region",
	"thread-region",
	"panel-region",
	"drawer-region",
	"palette-region",
	"settings-region",
];

/// A region that can hold focus, drawn as a focusable box named by its
/// selector while `drawn` holds for the layout.
struct Region {
	name:    &'static str,
	focus:   FocusHandle,
	drawn:   fn(&WorkspaceLayout) -> bool,
	_layout: Subscription,
}

impl Region {
	fn new(
		name: &'static str,
		focus: FocusHandle,
		drawn: fn(&WorkspaceLayout) -> bool,
		cx: &mut Context<Self>,
	) -> Self {
		let layout = cx.observe_global::<WorkspaceLayout>(|_, cx| cx.notify());
		Self { name, focus, drawn, _layout: layout }
	}
}

impl Render for Region {
	fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let name = self.name;
		div()
			.size_full()
			.when((self.drawn)(WorkspaceLayout::get(cx)), |root| {
				root.child(
					div()
						.debug_selector(move || name.to_owned())
						.track_focus(&self.focus)
						.size_full(),
				)
			})
	}
}

const fn always(_: &WorkspaceLayout) -> bool {
	true
}

/// The palette draws its field only while it is open, as the real one does.
const fn palette_open(layout: &WorkspaceLayout) -> bool {
	layout.palette_open
}

/// A workspace with the sidebar, panel and drawer open, under reduced motion
/// so a closed region leaves the next frame, showing session `a` when
/// `session`. The thread's focus is the composer's slot.
fn open(
	cx: &mut TestAppContext,
	session: bool,
) -> (Entity<Workspace>, HashMap<&'static str, FocusHandle>, &mut VisualTestContext) {
	cx.update(|cx| Theme::install(Appearance::Dark, cx))
		.expect("the dark palette parses");
	cx.update(|cx| {
		cx.set_reduce_motion(true);
		workspace::init(cx);
	});
	let mut store = Store::new();
	store.persisted.shell.active_session = session.then(|| SessionId::from("a"));
	let app = cx.update(|cx| cx.new(|_| AppState::new(store)));
	let layout =
		PanelsStore { right_panel_visible: true, drawer_visible: true, ..PanelsStore::default() };
	let handles = HashMap::from(REGIONS.map(|name| (name, cx.update(|cx| cx.focus_handle()))));
	let given = handles.clone();
	let (workspace, cx) = cx.add_window_view(move |window, cx| {
		register_focus(FocusSlot::Composer, &given["thread-region"], cx);
		register_focus(FocusSlot::Palette, &given["palette-region"], cx);
		let mut region = |name: &'static str, drawn: fn(&WorkspaceLayout) -> bool| {
			let focus = given[name].clone();
			AnyView::from(cx.new(|cx| Region::new(name, focus, drawn, cx)))
		};
		let regions = Regions {
			sidebar:  region("sidebar-region", always),
			thread:   region("thread-region", always),
			panel:    region("panel-region", always),
			drawer:   region("drawer-region", always),
			palette:  region("palette-region", palette_open),
			settings: region("settings-region", always),
		};
		Workspace::new(app, regions, layout, window, cx)
	});
	cx.run_until_parked();
	(workspace, handles, cx)
}

/// Whether a frame drawn now draws `name`.
fn drawn(cx: &mut VisualTestContext, name: &'static str) -> bool {
	cx.update(|window, _| window.refresh());
	cx.run_until_parked();
	cx.debug_bounds(name).is_some()
}

/// Dispatches `action` from the focused node, as its key binding does.
fn press(cx: &mut VisualTestContext, action: Box<dyn Action>) {
	cx.update(|window, cx| window.dispatch_action(action, cx));
	cx.run_until_parked();
}

/// A region, the action that closes it and the one that opens it again.
struct Case {
	region: &'static str,
	close:  fn() -> Box<dyn Action>,
	open:   fn() -> Box<dyn Action>,
}

fn cases() -> [Case; 5] {
	[
		Case {
			region: "sidebar-region",
			close:  || Box::new(act::ToggleSidebar),
			open:   || Box::new(act::ToggleSidebar),
		},
		Case {
			region: "panel-region",
			close:  || Box::new(act::TogglePanel),
			open:   || Box::new(act::TogglePanel),
		},
		Case {
			region: "drawer-region",
			close:  || Box::new(act::ToggleDrawer),
			open:   || Box::new(act::ToggleDrawer),
		},
		Case {
			region: "settings-region",
			close:  || Box::new(act::CloseSettings),
			open:   || Box::new(act::OpenSettings { page: None }),
		},
		Case {
			region: "palette-region",
			close:  || Box::new(act::ClosePalette),
			open:   || Box::new(act::OpenPalette),
		},
	]
}

/// Closes each region while it holds focus and asserts that the keys that
/// closed it open it again and where focus went: the composer only while the
/// thread holding it is drawn once the region closed. With `settings`, the
/// settings are opened first and stand in the thread's place.
fn sweep(session: bool, settings: bool) {
	for case in cases() {
		let mut cx = TestAppContext::single();
		let (workspace, handles, cx) = open(&mut cx, session);
		let name = case.region;
		let region = handles[name].clone();
		if settings {
			press(cx, Box::new(act::OpenSettings { page: None }));
		}
		if !drawn(cx, name) {
			press(cx, (case.open)());
		}
		cx.update(|window, cx| window.focus(&region, cx));
		assert!(drawn(cx, name), "{name} is drawn before it closes");
		assert!(cx.update(|window, _| region.is_focused(window)), "{name} holds focus");

		press(cx, (case.close)());
		assert!(!drawn(cx, name), "{name} leaves the frame once closed");
		let holder = cx.update(|window, cx| {
			let composer = handles["thread-region"].is_focused(window);
			let root = workspace.read(cx).focus_handle(cx).is_focused(window);
			(composer, root)
		});
		press(cx, (case.open)());
		assert!(drawn(cx, name), "the keys that closed {name} open it again");
		let thread_drawn = session && (!settings || name == "settings-region");
		assert_eq!(
			holder,
			(thread_drawn, !thread_drawn),
			"closing {name}: (composer, workspace) focused"
		);
	}
}

#[test]
fn with_a_session_open_the_composer_takes_the_keys_back() {
	sweep(true, false);
}

#[test]
fn with_no_session_open_the_workspace_takes_the_keys_back() {
	sweep(false, false);
}

#[test]
fn with_the_settings_in_the_threads_place_the_workspace_takes_the_keys_back() {
	sweep(true, true);
}
