//! Every line of the sidebar list spans the list's width.
//!
//! WHY: a list line is laid out as a root, and a flex root with no width is
//! as wide as its content. A thread row sized that way puts its time label
//! beside the title instead of at the list's right edge, never truncates a
//! long title, and runs its label past the sidebar's edge, where the sidebar
//! cuts it. The suite sweeps every line the listing produces, one of each
//! kind, with motion reduced so no sliding wrapper stretches the line for it.
//!
//! Gap: the drawn pixels are not asserted, only the laid-out bounds; a line
//! whose content overflows a line of the right width is not caught here.

use gpui::{Bounds, Pixels, TestAppContext, VisualTestContext, px, size};
use veyyon_desktop_app::{AppState, driver, sidebar::listing::Item};
use veyyon_desktop_model::QueuePartition;
use veyyon_desktop_ui::theme::space;

use super::{items, listing, sid, sidebar, summary};

/// The target id the sidebar records `item` under.
fn target(item: &Item, state: &AppState) -> String {
	let projects = state.projects();
	match *item {
		Item::Block { block, .. } => format!("sidebar.block:{}", block.key()),
		Item::Project(project) => format!("sidebar.project:{}", projects[project].path),
		Item::Session { project, row, .. } => {
			format!("sidebar.row:{}", projects[project].sessions[row].id.0)
		},
		Item::Older(_) => "sidebar.older".to_owned(),
	}
}

/// The kind of `item`, as its variant name.
const fn kind(item: &Item) -> &'static str {
	match item {
		Item::Block { .. } => "block",
		Item::Project(_) => "project",
		Item::Session { .. } => "session",
		Item::Older(_) => "older",
	}
}

fn bounds(cx: &mut VisualTestContext, id: &str) -> Bounds<Pixels> {
	cx.update(|window, cx| driver::bounds(cx, window.window_handle().window_id(), id))
		.unwrap_or_else(|| panic!("{id} is laid out"))
}

#[gpui::test]
fn every_line_spans_the_list_from_its_left_inset_to_its_right_inset(app: &mut TestAppContext) {
	driver::enable();
	// Twenty-seven archived threads list a project header, the archive
	// header, a page of rows and the `Older` line.
	let threads = (0..27u64)
		.map(|n| summary(&format!("t{n:02}"), "/w/alpha", 1000 - n, None))
		.collect();
	let (state, view, cx) = sidebar(app, vec![listing(threads)]);
	cx.update(|_, cx| cx.set_reduce_motion(true));
	// As narrow as a sidebar is drawn, and tall enough to lay out every line.
	cx.simulate_resize(size(px(260.0), px(1400.0)));
	state.update(cx, |state, cx| {
		for n in 0..27u64 {
			state.place_session(&sid(&format!("t{n:02}")), QueuePartition::Parked, n, cx);
		}
	});
	cx.run_until_parked();

	let sidebar = bounds(cx, "sidebar");
	// The list is inset by `space::S2` on each side, inside the sidebar's
	// one-pixel right border.
	let left = sidebar.left() + space::S2;
	let right = sidebar.right() - px(1.0) - space::S2;
	let lines = items(&view, cx);
	let mut kinds: Vec<&str> = lines.iter().map(kind).collect();
	kinds.sort_unstable();
	kinds.dedup();
	assert_eq!(kinds, ["block", "older", "project", "session"], "the sweep draws every kind");

	for line in &lines {
		let id = state.read_with(cx, |state, _| target(line, state));
		let drawn = bounds(cx, &id);
		assert_eq!((drawn.left(), drawn.right()), (left, right), "{id} spans the list");
	}
}
