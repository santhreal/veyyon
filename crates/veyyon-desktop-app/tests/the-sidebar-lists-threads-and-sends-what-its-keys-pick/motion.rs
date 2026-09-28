//! Row motion: a thread that moves up the list slides from the row it left and
//! lands on its new one.
//!
//! WHY: a relisted sidebar that jumps loses the thread the eye was on; the
//! list slides each moved line from where it was drawn (FLIP on the row
//! origin). A motion that starts from the new row, never lands, or runs under
//! reduced motion is the defect this suite catches.
//!
//! Gap: the fade of a line that enters the list is not asserted, nor that a
//! new filter relists without motion.

use std::time::Duration;

use gpui::{Entity, Pixels, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{AppState, driver};
use veyyon_desktop_ui::theme::size;

use super::{listing, seeded, sidebar, summary};

/// The top edge of driver target `id` in a frame drawn now.
fn top(cx: &mut VisualTestContext, id: &str) -> Pixels {
	cx.update(|window, _| window.refresh());
	cx.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
		.map_or_else(|| panic!("{id} is laid out"), |bounds| bounds.origin.y)
}

/// Draws the frame `by` after the last.
fn after(cx: &mut VisualTestContext, by: Duration) {
	cx.executor().advance_clock(by);
	cx.update(|window, _| window.refresh());
	cx.run_until_parked();
}

/// `c` becomes the latest thread, so `beta` and `c` move to the top.
fn c_moves_up(state: &Entity<AppState>, cx: &mut VisualTestContext) {
	let relisted = listing(vec![
		summary("a", "/w/alpha", 100, None),
		summary("b", "/w/alpha", 200, None),
		summary("c", "/w/beta", 300, None),
	]);
	state.update(cx, |state, cx| state.apply(vec![relisted], cx));
	cx.run_until_parked();
}

#[gpui::test]
fn a_thread_that_moves_up_slides_from_the_row_it_left_and_lands_on_its_new_one(
	app: &mut TestAppContext,
) {
	driver::enable();
	let (state, _view, cx) = sidebar(app, seeded());
	cx.update(|_, cx| cx.set_reduce_motion(false));
	let left = top(cx, "sidebar.row:c");

	c_moves_up(&state, cx);
	assert_eq!(top(cx, "sidebar.row:c"), left, "the first frame draws c on the row it left");

	after(cx, Duration::from_millis(60));
	let moving = top(cx, "sidebar.row:c");

	// The beta header slides with c, so c's slot is read once both land.
	after(cx, Duration::from_secs(2));
	let slot = top(cx, "sidebar.project:/w/beta") + size::ROW;
	assert_eq!(top(cx, "sidebar.row:c"), slot, "c lands under the beta header");
	assert!(moving < left && moving > slot, "c is between its rows mid-motion: {moving:?}");
}

#[gpui::test]
fn under_reduced_motion_a_thread_that_moves_up_is_drawn_on_its_new_row_at_once(
	app: &mut TestAppContext,
) {
	driver::enable();
	let (state, _view, cx) = sidebar(app, seeded());
	cx.update(|_, cx| cx.set_reduce_motion(true));

	c_moves_up(&state, cx);
	let slot = top(cx, "sidebar.project:/w/beta") + size::ROW;
	assert_eq!(top(cx, "sidebar.row:c"), slot);
}
