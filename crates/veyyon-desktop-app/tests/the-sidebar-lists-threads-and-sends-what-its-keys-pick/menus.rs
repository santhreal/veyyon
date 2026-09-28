//! The thread row menu opened on a thread other than the open one.
//!
//! WHY: the row menu opens on the row under the pointer, not on the open
//! thread, and states the gate of each verb it offers. A menu built once when
//! it opens keeps drawing a verb `In flight` after the host answered, and
//! keeps offering a verb the host withdrew while it was open, which is a
//! refusal the operator reads only after picking. A verb added to the menu
//! without a gate is offered whatever the host declares. The suite opens the
//! menu on a thread that is not open, answers a request while the menu stays
//! open, and withdraws every capability the host declares in turn, so a new
//! capability or a new verb is swept without being listed here.
//!
//! Gap: a gate is the window's, not a thread's. A request in flight for one
//! thread marks every verb of its capability `In flight` on the menu of any
//! row, and nothing here asserts otherwise. How a refused row draws, and the
//! reason a withdrawn capability states, are the overlay kit's.

use std::collections::BTreeMap;

use gpui::{Entity, Modifiers, MouseButton, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{AppState, driver, sidebar::Sidebar};
use veyyon_desktop_model::{Capability, CapabilityStatus, HostAction, HostEvent, SnapshotSection};
use veyyon_desktop_ui::overlays::MenuItem;

use super::{seeded, sent, sid, sidebar};

/// The verbs a request of the `Sessions` capability in flight holds back.
const SESSIONS_VERBS: [&str; 4] = ["Rename", "Export as HTML", "Compact", "Handoff"];

/// Opens the thread menu on the row of `session` with a right press.
fn menu_on(cx: &mut VisualTestContext, session: &str) {
	let id = format!("sidebar.row:{session}");
	let at = cx
		.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), &id))
		.map_or_else(|| panic!("{id} is laid out"), |bounds| bounds.center());
	cx.simulate_mouse_down(at, MouseButton::Right, Modifiers::none());
	cx.simulate_mouse_up(at, MouseButton::Right, Modifiers::none());
	cx.run_until_parked();
}

/// The labels of the rows the open thread menu refuses, in menu order.
fn refused(view: &Entity<Sidebar>, cx: &VisualTestContext) -> Vec<String> {
	view.read_with(cx, |view, cx| {
		let menu = view.row_menu().read(cx);
		assert!(menu.is_open(cx), "the thread menu is open");
		menu.menu()
			.read(cx)
			.items()
			.iter()
			.filter_map(|item| match item {
				MenuItem::Row(row) if row.is_disabled() => Some(row.label().to_string()),
				_ => None,
			})
			.collect()
	})
}

/// How many `In flight` marks the window draws now.
fn in_flight_marks(cx: &mut VisualTestContext) -> usize {
	cx.update(|window, _| window.refresh());
	cx.run_until_parked();
	cx.update(|window, _| {
		window
			.rendered_text_runs()
			.iter()
			.map(|run| run.text.to_string())
			.filter(|text| text == "In flight")
			.count()
	})
}

/// The host declaring `capability` as `status`.
fn declare(
	state: &Entity<AppState>,
	cx: &mut VisualTestContext,
	capability: Capability,
	status: CapabilityStatus,
) {
	let declared = SnapshotSection::Capabilities(vec![(capability, status)]);
	state.update(cx, |state, cx| state.apply(vec![HostEvent::Snapshot(declared)], cx));
	cx.run_until_parked();
}

#[gpui::test]
fn a_row_menu_left_open_on_a_thread_that_is_not_open_drops_in_flight_when_the_host_answers(
	app: &mut TestAppContext,
) {
	driver::enable();
	let (state, view, cx) = sidebar(app, seeded());
	// `a` is open; opening `c` leaves `a` a thread that is not open while
	// the host has not answered the open.
	let open = state.update(cx, |state, cx| state.open_session(sid("c"), cx));
	cx.run_until_parked();
	assert_eq!(sent(&state, cx), vec![HostAction::OpenSession { session: sid("c") }]);

	menu_on(cx, "a");
	assert_eq!(
		refused(&view, cx),
		SESSIONS_VERBS,
		"an open in flight holds back every verb of its capability"
	);
	assert_eq!(in_flight_marks(cx), SESSIONS_VERBS.len(), "each held verb states it is in flight");

	state.update(cx, |state, cx| state.apply(vec![HostEvent::RequestSucceeded { request: open }], cx));
	cx.run_until_parked();
	assert_eq!(
		refused(&view, cx),
		Vec::<String>::new(),
		"the menu left open states the answered open as no longer in flight"
	);
	assert_eq!(in_flight_marks(cx), 0, "no verb is drawn in flight after the answer");

	cx.simulate_keystrokes("c enter");
	cx.run_until_parked();
	assert_eq!(
		sent(&state, cx),
		vec![HostAction::CompactSession { session: sid("a") }],
		"the verb held back until the answer is picked from the same menu for its row"
	);
}

#[gpui::test]
fn every_capability_the_host_withdraws_refuses_its_verbs_in_a_row_menu_on_a_thread_that_is_not_open(
	app: &mut TestAppContext,
) {
	driver::enable();
	let (state, view, cx) = sidebar(app, seeded());
	// `a` is open; the menu opens on `c` and stays open throughout.
	menu_on(cx, "c");
	assert_eq!(refused(&view, cx), Vec::<String>::new(), "a host that withdrew nothing");

	let mut withdrawn: BTreeMap<Capability, Vec<String>> = BTreeMap::new();
	for capability in Capability::ALL {
		let reason = format!("{capability:?} withdrawn");
		declare(&state, cx, capability, CapabilityStatus::Unavailable { reason });
		let off = refused(&view, cx);
		if !off.is_empty() {
			withdrawn.insert(capability, off);
		}
		declare(&state, cx, capability, CapabilityStatus::Available);
		assert_eq!(
			refused(&view, cx),
			Vec::<String>::new(),
			"{capability:?} declared again is offered again"
		);
	}

	let verbs =
		|verbs: &[&str]| -> Vec<String> { verbs.iter().map(|verb| (*verb).to_owned()).collect() };
	assert_eq!(
		withdrawn,
		BTreeMap::from([
			(Capability::Sessions, verbs(&SESSIONS_VERBS)),
			(Capability::SessionDeletion, verbs(&["Delete"])),
			(Capability::SessionTreeNavigation, verbs(&["Branch"])),
			(Capability::Transcript, verbs(&["Peek"])),
		]),
		"each verb the host takes is refused with its own capability and no other"
	);
	assert_eq!(sent(&state, cx), Vec::<HostAction>::new(), "nothing was picked");
}
