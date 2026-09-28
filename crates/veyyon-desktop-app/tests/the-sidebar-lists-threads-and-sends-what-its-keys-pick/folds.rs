//! Branch folds and collapsed projects and blocks, read from and written to
//! the store the window reopens from.
//!
//! WHY: a fold the view keeps to itself is lost when the window reopens, and
//! a fold written under the wrong key reopens a different thread folded. A
//! thread opened from elsewhere into a collapsed project is open and not
//! listed.
//!
//! Gap: the file the store is written to is not read back here.

use gpui::{Entity, TestAppContext, VisualTestContext};
use veyyon_desktop_app::{
	AppState,
	actions::sidebar::{FoldSelected, SelectNext, UnfoldSelected},
	sidebar::listing::{Block, Branches, Item},
};
use veyyon_desktop_model::{QueuePartition, Store};

use super::{
	branched, items, leaf, lines, listing, opened, row, sid, sidebar, sidebar_over, summary,
};

/// The session files whose branches the store records as folded.
fn folded_parents(state: &Entity<AppState>, cx: &VisualTestContext) -> Vec<String> {
	state.read_with(cx, |state, _| {
		state
			.store()
			.persisted
			.queue
			.collapsed_parents
			.iter()
			.cloned()
			.collect()
	})
}

#[gpui::test]
fn branches_list_under_the_nearest_listed_parent_and_fold_under_it(app: &mut TestAppContext) {
	let (state, view, cx) = sidebar(app, branched());
	let open = vec![
		Item::Project(0),
		row(0, 0, 0, Branches::Shown),
		row(0, 1, 1, Branches::Shown),
		row(0, 2, 2, Branches::None),
	];
	assert_eq!(items(&view, cx), open);

	cx.dispatch_action(SelectNext);
	cx.dispatch_action(FoldSelected);
	cx.run_until_parked();
	assert_eq!(items(&view, cx), vec![Item::Project(0), row(0, 0, 0, Branches::Folded)]);
	assert_eq!(folded_parents(&state, cx), vec!["/sessions/r.jsonl"], "the fold is in the store");
	cx.dispatch_action(UnfoldSelected);
	cx.run_until_parked();
	assert_eq!(items(&view, cx), open);
	assert_eq!(folded_parents(&state, cx), Vec::<String>::new());

	state.update(cx, |state, _| {
		assert_eq!(lines(state, &[], &["r1"], ""), vec![
			Item::Project(0),
			row(0, 0, 0, Branches::Shown),
			row(0, 1, 1, Branches::Folded),
		]);
		assert_eq!(
			lines(state, &[], &["r"], "title r2"),
			vec![Item::Project(0), leaf(0, 2)],
			"a filter lists folded matches under their nearest listed parent"
		);
	});
	state.update(cx, |state, cx| state.place_session(&sid("r"), QueuePartition::Pinned, 1, cx));
	cx.run_until_parked();
	assert_eq!(items(&view, cx), vec![
		Item::Block { block: Block::Pinned, count: 1 },
		leaf(0, 0),
		Item::Project(0),
		row(0, 1, 0, Branches::Shown),
		row(0, 2, 1, Branches::None),
	]);
}

#[gpui::test]
fn a_sidebar_lists_the_folds_its_store_was_left_with_and_reveals_the_thread_opened(
	app: &mut TestAppContext,
) {
	let mut store = Store::new();
	let queue = &mut store.persisted.queue;
	queue
		.collapsed_sections
		.extend(["pinned".to_owned(), "project:/w/beta".to_owned()]);
	queue
		.collapsed_parents
		.insert("/sessions/r.jsonl".to_owned());
	let (state, view, cx) = sidebar_over(app, store, vec![listing(vec![
		summary("r", "/w/alpha", 300, None),
		summary("r1", "/w/alpha", 250, Some("r")),
		summary("p", "/w/alpha", 100, None),
		summary("c", "/w/beta", 50, None),
	])]);
	state.update(cx, |state, cx| state.place_session(&sid("p"), QueuePartition::Pinned, 1, cx));
	cx.run_until_parked();
	assert_eq!(items(&view, cx), vec![
		Item::Block { block: Block::Pinned, count: 1 },
		Item::Project(0),
		row(0, 0, 0, Branches::Folded),
		Item::Project(1),
	]);

	state.update(cx, |state, cx| state.apply(vec![opened("c", "/w/beta")], cx));
	cx.run_until_parked();
	assert_eq!(
		items(&view, cx),
		vec![
			Item::Block { block: Block::Pinned, count: 1 },
			Item::Project(0),
			row(0, 0, 0, Branches::Folded),
			Item::Project(1),
			leaf(1, 0),
		],
		"opening a thread in a collapsed project expands the project"
	);
	let sections = state.read_with(cx, |state, _| {
		state
			.store()
			.persisted
			.queue
			.collapsed_sections
			.iter()
			.cloned()
			.collect::<Vec<_>>()
	});
	assert_eq!(sections, vec!["pinned".to_owned()]);
}
