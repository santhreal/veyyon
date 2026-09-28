//! The session tree sheet asks the host for its session's tree when it opens,
//! draws the rows each filter shows, and sends what its rows pick: a
//! navigation, with or without a summary of the branch left, the stop of that
//! summary, and a label.
//!
//! WHY: the sheet is the window's `/tree`. A row a filter hides must not be
//! drawn and a row it shows must be, for every filter the model declares; Enter
//! on the leaf must send nothing; a summary the host offers must be asked for
//! the way the terminal asks; Escape during a summary must stop it once rather
//! than close the sheet over a navigation in flight; a label must be sent
//! trimmed, cleared when empty and not at all when unchanged; and a refusal
//! must be stated in the host's words. The suite drives the real
//! `SessionTreeSheet` as a window's root over an `AppState` fed host events,
//! presses its keys, clicks its drawn text and reads the drawn text, the entry
//! the keyboard is on and the requests queued.
//!
//! Gap: the sheet draws the host's `shown_in`, `depth` and order as given;
//! whether those follow the terminal's rules is the host's suite. The tone of
//! a role marker is not read back.

mod harness;
mod label;
mod moves;
mod steps;

use std::time::Duration;

use gpui::TestAppContext;
use strum::IntoEnumIterator as _;
use veyyon_desktop_model::SessionTreeFilter as Filter;

use self::harness::{
	branched, browsing, capabilities, load_tree, long, rows_in, succeeded, tree_of, window,
};

/// The chord that picks `filter`: Alt with the first letter of its name.
const fn chord(filter: Filter) -> &'static str {
	match filter {
		Filter::Default => "alt-d",
		Filter::NoTools => "alt-t",
		Filter::UserOnly => "alt-u",
		Filter::LabeledOnly => "alt-l",
		Filter::All => "alt-a",
	}
}

#[gpui::test]
fn opening_asks_for_the_sessions_tree_and_draws_that_sessions_alone(app: &mut TestAppContext) {
	let mut w = window(app, vec![capabilities()]);
	let load = w.one();
	assert_eq!(load.action, load_tree(), "the sheet asks for its session's tree as it opens");
	assert!(w.draws("Loading the session tree…"), "it states the tree is loading: {:?}", w.texts());

	let mut elsewhere = long(1);
	elsewhere.nodes[0].text = "another session's entry".to_owned();
	w.apply(vec![tree_of("other", elsewhere)]);
	assert!(!w.draws("another session's entry"), "another session's tree is not drawn");
	assert!(w.draws("Loading the session tree…"), "the sheet still waits on its own");

	let tree = branched(false);
	w.apply(vec![tree_of(harness::SESSION, tree.clone()), succeeded(load.id)]);
	assert_eq!(w.drawn_rows(&tree), rows_in(&tree, Filter::Default), "its own tree is drawn");
	assert_eq!(w.closed(), 0, "the tree the host took to send does not close the sheet");
	assert_eq!(w.selected().as_deref(), Some("a2"), "the keyboard starts on the leaf");
}

#[gpui::test]
fn each_filter_draws_exactly_the_rows_the_host_lists_it_in(app: &mut TestAppContext) {
	let tree = branched(false);
	let mut w = browsing(app, tree.clone());
	for filter in Filter::iter() {
		w.keys(chord(filter));
		let expected = rows_in(&tree, filter);
		assert!(!expected.is_empty(), "the fixture shows a row under {filter:?}");
		assert_eq!(w.drawn_rows(&tree), expected, "{filter:?} draws the rows it lists");
	}
	assert!(w.sent().is_empty(), "picking a filter sends nothing");
}

#[gpui::test]
fn ctrl_o_cycles_the_filters_in_the_terminals_order_from_the_hosts_and_ctrl_shift_o_back(
	app: &mut TestAppContext,
) {
	let mut tree = branched(false);
	tree.filter = Filter::UserOnly;
	let mut w = browsing(app, tree.clone());
	let order: Vec<Filter> = Filter::iter().collect();
	let start = order
		.iter()
		.position(|filter| *filter == Filter::UserOnly)
		.expect("the order lists every filter");
	assert_eq!(
		w.drawn_rows(&tree),
		rows_in(&tree, Filter::UserOnly),
		"the sheet opens in the filter the host names"
	);
	for step in 1..=order.len() {
		w.keys("ctrl-o");
		let filter = order[(start + step) % order.len()];
		assert_eq!(w.drawn_rows(&tree), rows_in(&tree, filter), "ctrl-o {step} shows {filter:?}");
	}
	for step in 1..=order.len() {
		w.keys("ctrl-shift-o");
		let filter = order[(start + order.len() - step) % order.len()];
		assert_eq!(
			w.drawn_rows(&tree),
			rows_in(&tree, filter),
			"ctrl-shift-o {step} shows {filter:?}"
		);
	}
}

#[gpui::test]
fn a_filters_chip_picks_it(app: &mut TestAppContext) {
	let tree = branched(false);
	let mut w = browsing(app, tree.clone());
	w.click_text("User only", 1);
	assert_eq!(w.drawn_rows(&tree), rows_in(&tree, Filter::UserOnly));
	w.click_text("All", 1);
	assert_eq!(w.drawn_rows(&tree), rows_in(&tree, Filter::All));
}

#[gpui::test]
fn a_filter_that_hides_the_keyboards_row_lands_on_the_leaf_else_the_path_else_the_first_row(
	app: &mut TestAppContext,
) {
	// Default shows u1 a1 t1 u2 a2 b1 b2; the leaf is a2.
	let mut w = browsing(app, branched(false));
	w.keys("home alt-t");
	assert_eq!(
		w.selected().as_deref(),
		Some("u1"),
		"a row the filter still shows keeps the keyboard"
	);
	w.keys("alt-d end alt-u");
	assert_eq!(w.selected().as_deref(), Some("u2"), "with the leaf hidden: the path's last row");
	w.keys("alt-l");
	assert_eq!(w.selected().as_deref(), Some("b1"), "with no path row shown: the first row");
	w.keys("alt-d up up up");
	assert_eq!(w.selected().as_deref(), Some("t1"));
	w.keys("alt-t");
	assert_eq!(w.selected().as_deref(), Some("a2"), "with the leaf shown: the leaf");
}

#[gpui::test]
fn the_sheet_asks_for_no_frame_at_rest(app: &mut TestAppContext) {
	let mut w = browsing(app, branched(false));
	assert!(!w.frame(), "an open sheet asks for no frame");
	w.keys("up ctrl-o");
	w.settle(Duration::from_millis(400));
	assert!(!w.frame(), "nor once the colours a key changed have settled");
}
