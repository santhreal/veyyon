//! Output scrolled off the top of the grid is reached with the wheel, the
//! grid states how far back it shows, and one press returns it to the
//! newest output.
//!
//! WHY: a terminal scrolled back draws no caret and reads like one whose
//! shell stopped writing; with nothing stating how far back it is, output
//! arriving below the view goes unseen.
//!
//! Gap: the alternate screen, which keeps no history, is not driven.

use std::fmt::Write as _;

use gpui::{TestAppContext, point, px};
use veyyon_desktop_model::HostAction;
use veyyon_desktop_ui::theme::text;

use super::{harness::output, running};

#[gpui::test]
fn the_wheel_scrolls_back_and_the_badge_returns_the_grid_to_the_newest_output(
	app: &mut TestAppContext,
) {
	let mut w = running(app);
	let (_, rows) = w.cells().expect("the grid's box was measured");
	let written = u32::from(rows) + 20;
	let lines = (0..written).fold(String::new(), |mut lines, n| {
		write!(lines, "line {n}\r\n").expect("a String takes every write");
		lines
	});
	w.apply(vec![output("t1", 1, &lines)]);
	let newest = format!("line {}", written - 1);
	assert!(w.draws(&newest), "the grid follows the newest output: {:?}", w.texts());
	assert!(w.bounds("drawer.follow").is_none(), "a grid at its newest output states no scroll");

	let grid = w
		.bounds("drawer.grid:terminal:t1")
		.expect("the grid is laid out");
	w.scroll(grid.center(), point(px(0.0), text::MONO.line_height * 5.0));
	assert!(w.draws("5 lines back"), "the grid states how far back it shows: {:?}", w.texts());
	assert!(!w.draws(&newest), "the newest rows are below the view");
	let badge = w.bounds("drawer.follow").expect("the badge is laid out");
	assert!(grid.contains(&badge.origin), "over the grid, which keeps its box: {badge:?} {grid:?}");

	w.click("drawer.follow");
	assert!(w.draws(&newest), "the press returns to the newest output");
	assert!(w.bounds("drawer.follow").is_none(), "and the badge leaves");
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "scrolling writes nothing to the terminal");
}
