//! A line wider than the panel stays readable to its end: the diff wraps it
//! unless wrapping is off, and the file viewer scrolls sideways to it.

use gpui::{TestAppContext, point, px};
use veyyon_desktop_app::panel::PanelTab;
use veyyon_desktop_model::{ChangeStatus, FileContentView, HostEvent, SnapshotSection};
use veyyon_desktop_ui::theme::text;

use super::{
	changed, changes_of,
	harness::{SESSION, opened, window},
	hunk,
};

/// A line some two thousand pixels of mono text wide.
fn long_line() -> String {
	format!("let long = \"{}\"; // the end", "x".repeat(300))
}

#[gpui::test]
fn a_line_wider_than_the_panel_wraps_in_the_diff_and_scrolls_sideways_in_the_viewer(
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
		&hunk(1, 1, 1),
		"-let short = 1;",
		&format!("+{long}"),
		"",
	]
	.join("\n");
	w.apply(vec![changes_of(vec![changed("src/long.rs", ChangeStatus::Modified, 1, 1)], diff)]);
	let one_line = text::MONO.line_height;
	let wrapped = w.run(&long).expect("the diff draws the long line");
	assert!(wrapped.size.height > one_line, "a changed line wider than the pane wraps: {wrapped:?}");

	w.click_text("Wrap");
	let clipped = w.run(&long).expect("the diff draws the long line");
	assert_eq!(clipped.size.height, one_line, "with wrapping off it draws on one line: {clipped:?}");

	w.click("panel.tab:files");
	w.sent();
	w.apply(vec![HostEvent::Snapshot(SnapshotSection::FileContent(FileContentView {
		path:       "src/long.rs".to_owned(),
		content:    format!("fn short() {{}}\n{long}\n"),
		size_bytes: 0,
		truncated:  false,
		binary:     false,
	}))]);
	let before = w.run(&long).expect("the viewer draws the long line");
	w.scroll(before.origin + point(px(40.0), before.size.height / 2.0), point(px(-300.0), px(0.0)));
	let after = w.run(&long).expect("the viewer draws the long line");
	assert!(
		after.origin.x < before.origin.x,
		"the viewer scrolls sideways to the rest of a long line: {before:?} then {after:?}"
	);
}
