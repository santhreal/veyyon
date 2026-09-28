//! A line wider than the panel stays readable to its end: the diff wraps it
//! unless wrapping is off, and with wrapping off the diff and the file viewer
//! scroll the code sideways while the line numbers stay where they are.
//!
//! Catches a pane that clips a long line with no way to reach its end, a
//! gutter that scrolls away with the code, a sideways gesture taken as a
//! scroll down the lines or a scroll down taken as a sideways one, an offset
//! that runs past the widest line's end, and a new file that opens scrolled.
//! Does not catch a wrong bound for a line whose widest glyphs rank below the
//! longest lines by bytes.

use gpui::{Bounds, Pixels, Point, TestAppContext, point, px};
use veyyon_desktop_app::panel::PanelTab;
use veyyon_desktop_model::{ChangeStatus, FileContentView, HostEvent, SnapshotSection};
use veyyon_desktop_ui::theme::text;

use super::{
	changed, changes_of,
	harness::{SESSION, Win, opened, window},
	hunk,
};

/// A line some two thousand pixels of mono text wide.
fn long_line() -> String {
	format!("let long = \"{}\"; // the end", "x".repeat(300))
}

/// Somewhere over the code of the line drawn at `line`.
fn over(line: Bounds<Pixels>) -> Point<Pixels> {
	line.origin + point(px(40.0), line.size.height / 2.0)
}

const fn sideways(by: f32) -> Point<Pixels> {
	point(px(by), px(0.0))
}

fn file(content: String) -> Vec<HostEvent> {
	vec![HostEvent::Snapshot(SnapshotSection::FileContent(FileContentView {
		path: "src/long.rs".to_owned(),
		content,
		size_bytes: 0,
		truncated: false,
		binary: false,
	}))]
}

fn drawn(w: &mut Win<'_>, text: &str) -> Bounds<Pixels> {
	w.run(text).unwrap_or_else(|| panic!("{text:?} is drawn"))
}

fn number(w: &mut Win<'_>, number: &str) -> Bounds<Pixels> {
	w.run_exact(number)
		.unwrap_or_else(|| panic!("line number {number} is drawn"))
}

/// Turns the wheel far past the end of `long` over `at`: the code stops with
/// the line's end at the pane's right edge, and turning further moves nothing.
fn stops_at_the_end(w: &mut Win<'_>, long: &str, at: Point<Pixels>) {
	w.scroll(at, sideways(-100_000.0));
	let end = drawn(w, long);
	let panel = w.bounds("panel").expect("the panel is laid out");
	assert!(
		(end.right() - panel.right()).abs() <= px(1.0),
		"the code stops with the line's end at the pane's edge: {end:?} in {panel:?}"
	);
	w.scroll(at, sideways(-300.0));
	assert_eq!(drawn(w, long), end, "the code scrolls no further than the line's end");
}

#[gpui::test]
fn a_long_diff_line_wraps_and_with_wrapping_off_scrolls_sideways_past_its_numbers(
	app: &mut TestAppContext,
) {
	let long = long_line();
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Diff);
	w.sent();
	let diff = [
		"diff --git a/src/long.rs b/src/long.rs",
		"--- a/src/long.rs",
		"+++ b/src/long.rs",
		&hunk(417, 1, 1),
		"-let short = 1;",
		&format!("+{long}"),
		"",
	]
	.join("\n");
	w.apply(vec![changes_of(vec![changed("src/long.rs", ChangeStatus::Modified, 1, 1)], diff)]);
	let one_line = text::MONO.line_height;
	let wrapped = drawn(&mut w, &long);
	assert!(wrapped.size.height > one_line, "a changed line wider than the pane wraps: {wrapped:?}");

	w.click_text("Wrap");
	let start = drawn(&mut w, &long);
	assert_eq!(start.size.height, one_line, "with wrapping off it draws on one line: {start:?}");
	let numbers = number(&mut w, "417");
	w.scroll(over(start), sideways(-300.0));
	let moved = drawn(&mut w, &long);
	assert_eq!(
		moved.origin,
		start.origin - sideways(300.0),
		"the code scrolls sideways by the wheel's travel: {start:?} then {moved:?}"
	);
	assert_eq!(number(&mut w, "417"), numbers, "the line numbers stay put while the code moves");
	stops_at_the_end(&mut w, &long, over(start));
}

#[gpui::test]
fn the_viewer_scrolls_a_long_line_sideways_to_its_end_past_pinned_numbers(
	app: &mut TestAppContext,
) {
	let long = long_line();
	let lines: Vec<String> = (1..=60)
		.map(|n| {
			if n == 30 {
				long.clone()
			} else {
				format!("fn line_{n}() {{}}")
			}
		})
		.collect();
	let content = lines.join("\n");
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Files);
	w.sent();
	w.apply(file(content.clone()));
	let start = drawn(&mut w, &long);
	let numbers = number(&mut w, "30");
	let at = over(start);

	w.scroll(at, sideways(-300.0));
	let moved = drawn(&mut w, &long);
	assert_eq!(
		moved.origin,
		start.origin - sideways(300.0),
		"a sideways gesture moves the code sideways and never down the lines: {start:?} then \
		 {moved:?}"
	);
	assert_eq!(number(&mut w, "30"), numbers, "the line numbers stay put while the code moves");

	w.scroll(at, point(px(-5.0), px(-36.0)));
	let down = drawn(&mut w, &long);
	assert_eq!(
		down.origin,
		moved.origin - point(px(0.0), px(36.0)),
		"a gesture down the lines moves them up and leaves the code where it was: {moved:?} then \
		 {down:?}"
	);

	stops_at_the_end(&mut w, &long, at);

	w.apply(file(content));
	assert_eq!(
		drawn(&mut w, &long).origin.x,
		start.origin.x,
		"a new answer for the file opens at the lines' start"
	);
}
