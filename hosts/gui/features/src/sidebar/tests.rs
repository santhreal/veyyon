//! WHY THIS SUITE EXISTS.
//!
//! The column decides four things, and each has a failure that looks like a
//! rendering bug and is not:
//!
//! - the order rows appear in, which is the store's recency and not the order
//!   conversations were created;
//! - whether a checkout folds, since a fold offered over the only checkout is a
//!   control that does nothing;
//! - which row is drawn as open, where two or none is a column that lies about
//!   what is on screen;
//! - whether a row offers to delete itself, where offering it on the last
//!   conversation would leave a window with nothing selected.
//!
//! WHAT IT DOES NOT CATCH. Anything about the drawing: heights, hover washes
//! and the fold's animation need a window, and the capture pass is what covers
//! them.

use veyyon_gui_core::{
	command::Command,
	store::{
		model::{Project, ProjectId, Session, SessionId, Store},
		moves,
	},
};

use super::{logic, selected_child};

fn store() -> Store {
	Store::opened_in("veyyon", "/repo/veyyon")
}

/// Send one message so a conversation has a title and a preview of its own.
fn said(store: &mut Store, text: &str) {
	moves::set_draft(store, text.to_owned(), text.len());
	moves::send(store);
}

#[test]
fn one_checkout_is_a_quiet_heading_rather_than_a_fold() {
	let store = store();
	let columns = logic::columns(&store);
	assert_eq!(columns.len(), 1);
	assert!(!columns[0].foldable, "a fold over the only checkout does nothing");
	assert!(!columns[0].collapsed);
	assert_eq!(columns[0].name, "veyyon");
}

#[test]
fn a_folded_checkout_keeps_its_rows_so_the_fold_can_be_drawn_closing() {
	// The rows have to be in the returned value while the collapse animates. A
	// body that is absent the frame the fold starts cuts the animation to a
	// jump, which is the defect that made this a decision rather than a filter.
	let mut store = store();
	store.settings.group_by_folder = true;
	store.projects.push(veyyon_gui_core::store::model::Project {
		id:        veyyon_gui_core::store::model::ProjectId::new("second"),
		name:      "second".to_owned(),
		path:      "/repo/second".to_owned(),
		collapsed: true,
	});
	moves::new_session(&mut store);

	let columns = logic::columns(&store);
	assert_eq!(columns.len(), 2);
	assert!(columns.iter().all(|column| column.foldable));
	let folded = columns
		.iter()
		.find(|column| column.collapsed)
		.expect("one is folded");
	assert_eq!(folded.name, "second");
}

#[test]
fn grouping_is_off_until_there_is_more_than_one_checkout_to_tell_apart() {
	let mut store = store();
	store.settings.group_by_folder = true;
	assert!(
		!logic::columns(&store)[0].foldable,
		"the setting turned a single checkout into a foldable group of one"
	);
}

#[test]
fn the_rows_are_in_the_order_the_store_says_and_the_newest_is_first() {
	let mut store = store();
	said(&mut store, "the first thing");
	Command::NewSession.run(&mut store);
	said(&mut store, "the second thing");

	let rows = &logic::columns(&store)[0].rows;
	assert_eq!(rows.len(), 2);
	assert_eq!(rows[0].title, "the second thing");
	assert_eq!(rows[1].title, "the first thing");
	// A conversation is named after its first line, so while that line is all
	// there is, the row does not print it twice.
	assert_eq!(rows[0].preview, None);

	said(&mut store, "and then something else");
	let rows = &logic::columns(&store)[0].rows;
	assert_eq!(rows[0].preview.as_deref(), Some("and then something else"));
}

#[test]
fn exactly_one_row_is_drawn_as_the_conversation_on_screen() {
	let mut store = store();
	Command::NewSession.run(&mut store);
	Command::NewSession.run(&mut store);
	let columns = logic::columns(&store);
	let open: Vec<&logic::Entry> = columns
		.iter()
		.flat_map(|column| column.rows.iter())
		.filter(|entry| entry.active)
		.collect();
	assert_eq!(open.len(), 1);
	assert_eq!(Some(&open[0].id), store.selected.as_ref());
}

#[test]
fn no_row_is_drawn_as_open_when_nothing_is_selected() {
	// Reachable: deleting the last selected conversation before a new one is
	// chosen. A column that keeps drawing a fill then points at a transcript
	// that is not on screen.
	let mut store = store();
	store.selected = None;
	assert!(
		logic::columns(&store)
			.iter()
			.flat_map(|column| column.rows.iter())
			.all(|entry| !entry.active)
	);
}

#[test]
fn the_last_conversation_does_not_offer_to_delete_itself() {
	let mut store = store();
	assert!(!logic::deletable(&store), "the window would be left with nothing selected");
	Command::NewSession.run(&mut store);
	assert!(logic::deletable(&store));
	Command::DeleteSelected.run(&mut store);
	assert!(!logic::deletable(&store), "the offer outlived the second conversation");
}

#[test]
fn a_conversation_with_nothing_in_it_has_no_second_line() {
	// An empty preview would draw a blank line under the title and make every
	// untouched row taller than the one under it.
	let store = store();
	assert_eq!(logic::columns(&store)[0].rows[0].preview, None);
}

/// A second checkout holding one conversation, so grouping has something to
/// group and the second column has a row to address.
fn second_checkout(store: &mut Store) -> SessionId {
	let project = ProjectId::new("second");
	store.projects.push(Project {
		id:        project.clone(),
		name:      "second".to_owned(),
		path:      "/repo/second".to_owned(),
		collapsed: false,
	});
	let session = Session::new("second-1", &project, "over there");
	let id = session.id.clone();
	store.sessions.push(session);
	id
}

#[test]
fn a_row_under_a_heading_is_addressed_past_that_heading() {
	// The column is drawn as one box of rows so the keyboard can put a row back
	// in view, and a heading is a child of that box like a row is. The active
	// conversation is the newest, which is the first row under the heading.
	let mut store = store();
	Command::NewSession.run(&mut store);
	Command::NewSession.run(&mut store);

	assert_eq!(selected_child(&store), 1, "the newest row is the first under the heading");
	Command::CycleSession { forward: true }.run(&mut store);
	assert_eq!(selected_child(&store), 2, "a cycle addressed the wrong row");
	Command::CycleSession { forward: true }.run(&mut store);
	assert_eq!(selected_child(&store), 3);
}

#[test]
fn a_second_ungrouped_checkout_counts_its_own_heading() {
	// Grouping off with two checkouts is two quiet headings, so the row in the
	// second one is past both of them and past every row of the first: heading,
	// two rows, heading, row.
	let mut store = store();
	Command::NewSession.run(&mut store);
	let over_there = second_checkout(&mut store);
	store.settings.group_by_folder = false;

	let columns = logic::columns(&store);
	assert_eq!(columns.len(), 2);
	assert_eq!(columns[0].rows.len(), 2);
	assert_eq!(columns[1].rows.len(), 1);
	assert!(columns.iter().all(|column| !column.foldable), "grouping is off");

	Command::SelectSession(over_there).run(&mut store);
	assert_eq!(selected_child(&store), 4, "the second checkout's row was addressed as the first's");
}

#[test]
fn a_row_inside_a_fold_addresses_the_fold_that_holds_it() {
	// A folded checkout is one child holding its rows, so the row itself is not
	// a child of the box that scrolls. Bringing the fold into view is what is
	// available, and it is what the window does.
	let mut store = store();
	let over_there = second_checkout(&mut store);
	store.settings.group_by_folder = true;

	let columns = logic::columns(&store);
	assert!(columns.iter().all(|column| column.foldable), "grouping is on with two checkouts");
	assert_eq!(selected_child(&store), 0, "the first fold holds the conversation on screen");

	Command::SelectSession(over_there).run(&mut store);
	assert_eq!(selected_child(&store), 1, "a row in the second fold addressed the first fold");
}

#[test]
fn nothing_selected_addresses_the_first_child() {
	// Reachable while the last selected conversation is being deleted. The
	// first child is a heading, and scrolling to it is the top of the list.
	let mut store = store();
	store.selected = None;
	assert_eq!(selected_child(&store), 0);
}
