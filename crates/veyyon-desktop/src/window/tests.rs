//! What the window remembers is written when one debounce window has passed
//! since it changed, or when the window closes first, and the next window
//! reads back everything the closing one held.
//!
//! WHY: the window writes on the store events it receives. A draft, a fold, a
//! panel tab, the appearance and a review changed the persisted state without
//! emitting one, so each reached the disk only when an unrelated host event
//! arrived or at a clean close, and a window killed while idle lost them. The
//! app suite `store-events-name-only-what-changed::remembered` proves every
//! such change emits `Remembered`. This suite proves the window turns each
//! route into a write (a remembered store change, the layout the workspace
//! reports, the window's own bounds), lands it at the debounce deadline and
//! not before, still writes it when the window closes inside the window, and
//! loses nothing on the way to the next window.
//!
//! Time is the test executor's clock, so the deadline is exact.
//!
//! Gap: the routes are listed by hand. A fourth route into `Keep`, such as a
//! new subscription in `Host::new`, is not swept until it is added here. A
//! process killed before the deadline loses the change by design.

use std::time::Duration;

use gpui::{EmptyView, TestAppContext, VisualTestContext};
use veyyon_desktop::state::{DEBOUNCE_MS, StateDir};
use veyyon_desktop_app::{
	AppState,
	actions::workspace::TogglePanel,
	workspace::{Regions, Workspace},
};
use veyyon_desktop_model::{ComposerStore, PersistedState, SessionId, Store};
use veyyon_desktop_ui::theme::{Appearance, Theme};
use veyyon_gpui::{AnyView, AppContext as _, Entity, px, size};
use veyyon_test_scratch::{TempTree, scratch_dir};

use super::{host::Host, keep::Keep};

/// The text of the draft the draft route saves.
const DRAFT: &str = "half a prompt";

/// The session every window here displays.
fn session() -> SessionId {
	SessionId::from("a")
}

/// One way the window changes what it remembers, and whether a state read
/// from disk holds that change.
struct Route {
	name:   &'static str,
	change: fn(&Entity<AppState>, &mut VisualTestContext),
	holds:  fn(&PersistedState) -> bool,
}

/// Every route into what the window writes, one per kind of source.
const ROUTES: &[Route] = &[
	Route {
		name:   "a store change the window remembers",
		change: |app, cx| {
			app.update(cx, |app, cx| app.choose_appearance(Some(Appearance::Light), cx));
		},
		holds:  |state| state.shell.appearance.as_deref() == Some("light"),
	},
	Route {
		name:   "a draft of the displayed session",
		change: |app, cx| {
			let draft = ComposerStore { draft_text: DRAFT.to_owned(), ..ComposerStore::default() };
			app.update(cx, |app, cx| app.save_draft(session(), draft, cx));
		},
		holds:  |state| {
			state
				.composer
				.get(&session())
				.is_some_and(|draft| draft.draft_text == DRAFT)
		},
	},
	Route {
		name:   "the layout the workspace reports",
		change: |_, cx| {
			cx.dispatch_action(TogglePanel);
			cx.run_until_parked();
		},
		holds:  |state| {
			state
				.panels
				.get(&session())
				.is_some_and(|panels| panels.right_panel_visible)
		},
	},
	Route {
		name:   "the window's bounds",
		change: |_, cx| cx.simulate_resize(size(px(1111.0), px(777.0))),
		holds:  |state| (state.window.width, state.window.height) == (1111, 777),
	},
];

/// A state directory under a scratch tree, holding a state that displays
/// session `a` with its right panel shut.
fn seeded(label: &str) -> (TempTree, StateDir) {
	let tree = scratch_dir(label);
	let dir = StateDir::at(tree.path().join("desktop"));
	let mut seed = PersistedState::new();
	seed.shell.active_session = Some(session());
	Keep::new(Some(dir.clone()), &PersistedState::new()).write(&seed, 0);
	(tree, dir)
}

/// Moves the clock by `ms` and runs what came due.
fn advance(cx: &VisualTestContext, ms: u64) {
	cx.executor().advance_clock(Duration::from_millis(ms));
	cx.run_until_parked();
}

/// A window opened over `dir` as `window::open` opens one, with every region
/// drawn empty, once what opening scheduled has been written: the state it
/// read and the host that writes it back.
fn open<'a>(
	cx: &'a mut TestAppContext,
	dir: &StateDir,
) -> (Entity<AppState>, Entity<Host>, &'a mut VisualTestContext) {
	cx.update(|cx| Theme::install(Appearance::Dark, cx))
		.expect("the dark palette parses");
	let (persisted, rejections) = dir.load();
	assert!(rejections.is_empty(), "the seeded state was refused: {rejections:?}");
	let panels = persisted
		.shell
		.active_session
		.as_ref()
		.and_then(|session| persisted.panels.get(session))
		.cloned()
		.unwrap_or_default();
	let keep = Keep::new(Some(dir.clone()), &persisted);
	let app = cx.update(|cx| cx.new(|_| AppState::new(Store::with_persisted(persisted))));
	let state = app.clone();
	let (workspace, cx) = cx.add_window_view(move |window, cx| {
		let mut empty = || AnyView::from(cx.new(|_| EmptyView));
		let regions = Regions {
			sidebar:  empty(),
			thread:   empty(),
			panel:    empty(),
			drawer:   empty(),
			palette:  empty(),
			settings: empty(),
		};
		Workspace::new(state, regions, panels, window, cx)
	});
	let held = app.clone();
	let host = cx.update(|window, cx| cx.new(|cx| Host::new(held, &workspace, keep, window, cx)));
	cx.run_until_parked();
	advance(cx, DEBOUNCE_MS);
	(app, host, cx)
}

/// Closes the window as the process does: the window goes, and the slot
/// holding its host is emptied.
fn close(host: Entity<Host>, cx: &mut VisualTestContext) {
	cx.update(|window, _| window.remove_window());
	drop(host);
	TestAppContext::update(cx, |_| ());
	cx.run_until_parked();
}

#[test]
fn each_route_is_written_when_the_debounce_window_ends_and_not_before() {
	for route in ROUTES {
		let (_tree, dir) = seeded("window-writes-at-the-deadline");
		assert!(!(route.holds)(&dir.load().0), "{}: the seed already holds it", route.name);
		let mut cx = TestAppContext::single();
		let (app, _host, cx) = open(&mut cx, &dir);
		(route.change)(&app, cx);
		advance(cx, DEBOUNCE_MS - 1);
		assert!(
			!(route.holds)(&dir.load().0),
			"{}: written before the debounce window ended",
			route.name
		);
		advance(cx, 1);
		assert!(
			(route.holds)(&dir.load().0),
			"{}: not written when the debounce window ended",
			route.name
		);
	}
}

#[test]
fn a_window_closed_inside_the_debounce_window_writes_what_it_held() {
	for route in ROUTES {
		let (_tree, dir) = seeded("window-writes-on-close");
		let mut cx = TestAppContext::single();
		let (app, host, cx) = open(&mut cx, &dir);
		(route.change)(&app, cx);
		close(host, cx);
		assert!((route.holds)(&dir.load().0), "{}: lost when the window closed", route.name);
	}
}

#[test]
fn the_next_window_reads_back_everything_the_closing_one_held() {
	let (_tree, dir) = seeded("window-round-trip");
	let mut cx = TestAppContext::single();
	let (app, host, cx) = open(&mut cx, &dir);
	for route in ROUTES {
		(route.change)(&app, cx);
	}
	let mut held = app.read_with(cx, |app, _| app.store().persisted.clone());
	close(host, cx);

	let (read, rejections) = dir.load();
	assert!(rejections.is_empty(), "the next window refused the documents: {rejections:?}");
	for route in ROUTES {
		assert!((route.holds)(&read), "{}: not read back", route.name);
	}
	// The window's placement is the keeper's, not the store's.
	held.window.clone_from(&read.window);
	assert_eq!(read, held, "the next window reads a state other than the one the last held");
}
