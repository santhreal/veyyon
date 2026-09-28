//! The pointer paths: the refresh control, the thread row menu, the block
//! headers and the archive's `Older` line; and the profile menu the palette
//! opens.
//!
//! WHY: the row menu opens inside the sidebar, so a sidebar key binding that
//! also matches inside the menu takes Enter, the arrows and the placement
//! letters from it: Enter opens the selected thread instead of picking the
//! row, and a typed `p` pins the selected thread instead of highlighting
//! `Pin`. The same happens when the right press that opens the menu goes on
//! to focus the sidebar behind it. A line sliding under another mid-motion
//! shares its hitbox, and a click both take opens a thread under the one
//! clicked. A refresh control that stays enabled while its listing is in
//! flight sends one listing per click. An archive listed whole grows without
//! bound, and one paged or collapsed in the view alone reopens as it was not
//! left; a thread opened from elsewhere into a collapsed block or past the
//! listed page is open and not listed. A profile menu that only a sidebar
//! holding focus hears, or that opens before a hidden sidebar lays out its
//! button, is one the palette cannot reach.
//!
//! Gap: the menu's pointer picks and where the profile menu opens are not
//! driven here; an overlap is driven only between the `Older` line and a
//! thread row.

use gpui::{Entity, Modifiers, MouseButton, Pixels, Point, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{
	AppState,
	actions::sidebar::OpenProfileMenu,
	driver,
	sidebar::{
		Sidebar,
		listing::{Block, Item},
	},
	workspace::WorkspaceLayout,
};
use veyyon_desktop_model::{HostAction, HostEvent, QueuePartition};

use super::{items, leaf, listing, opened, seeded, sent, sid, sidebar, summary};

/// The centre of driver target `id` as last laid out.
fn centre(cx: &mut VisualTestContext, id: &str) -> Point<Pixels> {
	cx.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
		.map_or_else(|| panic!("{id} is laid out"), |bounds| bounds.center())
}

fn click(cx: &mut VisualTestContext, id: &str) {
	let at = centre(cx, id);
	cx.simulate_click(at, Modifiers::none());
	cx.run_until_parked();
}

fn right_click(cx: &mut VisualTestContext, id: &str) {
	let at = centre(cx, id);
	cx.simulate_mouse_down(at, MouseButton::Right, Modifiers::none());
	cx.simulate_mouse_up(at, MouseButton::Right, Modifiers::none());
	cx.run_until_parked();
}

fn keys(cx: &mut VisualTestContext, keystrokes: &str) {
	cx.simulate_keystrokes(keystrokes);
	cx.run_until_parked();
}

#[gpui::test]
fn the_refresh_control_lists_the_threads_once_until_the_host_answers(app: &mut TestAppContext) {
	driver::enable();
	let (state, _view, cx) = sidebar(app, seeded());
	click(cx, "sidebar.refresh");
	let requests = state.update(cx, |state, _| state.drain_outbox());
	let actions: Vec<HostAction> = requests
		.iter()
		.map(|request| request.action.clone())
		.collect();
	assert_eq!(actions, vec![HostAction::ListSessions]);

	click(cx, "sidebar.refresh");
	assert_eq!(sent(&state, cx), Vec::<HostAction>::new(), "the control waits for the answer");

	let request = requests[0].id;
	state.update(cx, |state, cx| state.apply(vec![HostEvent::RequestSucceeded { request }], cx));
	cx.run_until_parked();
	click(cx, "sidebar.refresh");
	assert_eq!(sent(&state, cx), vec![HostAction::ListSessions]);
}

#[gpui::test]
fn the_row_menu_takes_its_keys_and_sends_its_pick_for_the_row_it_opened_on(
	app: &mut TestAppContext,
) {
	driver::enable();
	let (state, _view, cx) = sidebar(app, seeded());
	let placed = |cx: &mut VisualTestContext, id: &str| {
		state.read_with(cx, |state, _| state.partition(&sid(id)))
	};

	// `a` is selected; the menu opens on `c`.
	right_click(cx, "sidebar.row:c");
	keys(cx, "p");
	assert_eq!(placed(cx, "a"), QueuePartition::Live, "a letter typed in the menu places nothing");
	keys(cx, "enter");
	assert_eq!(placed(cx, "c"), QueuePartition::Pinned, "enter picks the highlighted Pin");
	assert_eq!(placed(cx, "a"), QueuePartition::Live);
	assert_eq!(sent(&state, cx), Vec::<HostAction>::new(), "enter opened no thread");

	right_click(cx, "sidebar.row:c");
	keys(cx, "b enter");
	assert_eq!(sent(&state, cx), vec![HostAction::BranchSession {
		session: sid("c"),
		entry:   None,
	}]);

	right_click(cx, "sidebar.row:b");
	keys(cx, "e enter");
	assert_eq!(sent(&state, cx), vec![HostAction::ExportSession {
		session: sid("b"),
		format:  "html".to_owned(),
	}]);
}

/// Twenty-seven threads under `/w/alpha`, `t00` the newest, archived in
/// order so that `t26` is listed first and `t00` last. Motion is on and the
/// test clock stands still, so each archived row is still drawn on the row
/// it left: `t26` under the `Older` line.
fn archive(
	app: &mut TestAppContext,
) -> (Entity<AppState>, Entity<Sidebar>, &mut VisualTestContext) {
	driver::enable();
	let threads = (0..27u64)
		.map(|n| summary(&format!("t{n:02}"), "/w/alpha", 1000 - n, None))
		.collect();
	let (state, view, cx) = sidebar(app, vec![listing(threads)]);
	cx.update(|_, cx| cx.set_reduce_motion(false));
	state.update(cx, |state, cx| {
		for n in 0..27u64 {
			state.place_session(&sid(&format!("t{n:02}")), QueuePartition::Parked, n, cx);
		}
	});
	cx.run_until_parked();
	(state, view, cx)
}

/// The project header, the archive header and archived rows `down_to` to
/// 26, newest archived first.
fn archived_down_to(down_to: usize) -> Vec<Item> {
	let mut lines = vec![Item::Project(0), Item::Block { block: Block::Archived, count: 27 }];
	lines.extend((down_to..27).rev().map(|row| leaf(0, row)));
	lines
}

fn archive_state(state: &Entity<AppState>, cx: &VisualTestContext) -> (u32, Vec<String>) {
	state.read_with(cx, |state, _| {
		let queue = &state.store().persisted.queue;
		(queue.parked_page, queue.collapsed_sections.iter().cloned().collect())
	})
}

#[gpui::test]
fn the_older_line_lists_the_next_archived_page_and_a_collapse_is_written_to_the_store(
	app: &mut TestAppContext,
) {
	let (state, view, cx) = archive(app);
	let mut first_page = archived_down_to(2);
	first_page.push(Item::Older(2));
	assert_eq!(items(&view, cx), first_page);

	click(cx, "sidebar.older");
	assert_eq!(sent(&state, cx), Vec::<HostAction>::new(), "t26 drawn under the line is not opened");
	assert_eq!(items(&view, cx), archived_down_to(0));
	assert_eq!(archive_state(&state, cx), (2, Vec::new()));

	click(cx, "sidebar.block:parked");
	assert_eq!(items(&view, cx), archived_down_to(27));
	assert_eq!(archive_state(&state, cx), (2, vec!["parked".to_owned()]));

	state.update(cx, |state, cx| state.apply(vec![opened("t05", "/w/alpha")], cx));
	cx.run_until_parked();
	assert_eq!(
		items(&view, cx),
		archived_down_to(0),
		"opening an archived thread expands the archive"
	);
	assert_eq!(archive_state(&state, cx), (2, Vec::new()));
}

#[gpui::test]
fn opening_an_archived_thread_past_the_listed_page_pages_it_in(app: &mut TestAppContext) {
	let (state, view, cx) = archive(app);
	state.update(cx, |state, cx| state.apply(vec![opened("t00", "/w/alpha")], cx));
	cx.run_until_parked();
	assert_eq!(items(&view, cx), archived_down_to(0));
	assert_eq!(archive_state(&state, cx), (2, Vec::new()));
}

/// Runs the palette's `Switch profile` row from another window, where no
/// sidebar element is on the focus path, and picks `Refresh profiles` by key.
fn ask_profile_menu_and_refresh(cx: &mut VisualTestContext) {
	cx.add_empty_window().dispatch_action(OpenProfileMenu);
	cx.run_until_parked();
	cx.update(|window, cx| window.simulate_next_frame(cx));
	cx.run_until_parked();
	keys(cx, "r enter");
}

#[gpui::test]
fn the_profile_menu_action_opens_the_menu_from_anywhere_and_shows_a_hidden_sidebar(
	app: &mut TestAppContext,
) {
	let (state, _view, cx) = sidebar(app, seeded());
	ask_profile_menu_and_refresh(cx);
	assert_eq!(sent(&state, cx), vec![HostAction::RefreshProfiles], "the open menu took the keys");

	cx.update(|_, cx| WorkspaceLayout::update(cx, |layout| layout.sidebar_visible = false));
	ask_profile_menu_and_refresh(cx);
	assert!(cx.update(|_, cx| WorkspaceLayout::get(cx).sidebar_visible), "the sidebar is shown");
	assert_eq!(
		sent(&state, cx),
		vec![HostAction::RefreshProfiles],
		"the menu opens once the shown sidebar lays its button out"
	);
}
