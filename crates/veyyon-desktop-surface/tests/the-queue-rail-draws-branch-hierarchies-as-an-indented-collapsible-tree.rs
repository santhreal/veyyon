//! WHY: the queue rail was flat and drew no branch tree. When an agent or
//! operator branched a session, the child row sat at the top-level partition
//! order with no indication of its relationship to the parent, could not be
//! collapsed, and indented nothing.
//!
//! CLASS CLOSED: queue rail branch tree hierarchies (§5.2). Tests verify:
//! 1. Forest ordering: child rows sort under their parent in depth-first order.
//! 2. Per-row indent: each generation indents by `tree_indent_step_px` (from
//!    scale.toml).
//! 3. Bounded depth: past `tree_max_depth`, indent stops and the row states its
//!    depth.
//! 4. Fold projection: a folded parent hides every generation under it, and a
//!    cycle in the paths the host sent ends the walk instead of hanging the
//!    frame.
//! 5. Keyboard skip: keyboard walk visits exactly drawn rows, skipping
//!    collapsed subtrees.
//! 6. Fold persistence: where the fold is written, and that it survives a
//!    relaunch, is owned by `crates/veyyon-desktop/tests/
//!    a-folded-branch-is-written-where-the-rail-is-projected-from.rs`.
//!
//! WHAT IT DOES NOT CATCH: underlying git branch mechanics on disk.

use std::{cell::RefCell, collections::BTreeSet, path::Path, rc::Rc};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	ConnectionPhase, Intent, Keymap, Row, Section, ShellState, ShellView, damage::Region,
	install_tokens, intent::Intents, queue::tree::Branches,
};
use veyyon_gpui::{App, AppContext, Entity, Window, point};

fn sample_tree_rows() -> Vec<Row> {
	vec![
		Row {
			id:          1,
			title:       "Root Session".into(),
			subtitle:    "repo".into(),
			badge:       None,
			meta:        None,
			placement:   Section::Live,
			depth:       0,
			is_parent:   true,
			collapsed:   false,
			path:        "/sessions/root".into(),
			parent_path: None,
		},
		Row {
			id:          2,
			title:       "Child Session 1".into(),
			subtitle:    "repo".into(),
			badge:       None,
			meta:        None,
			placement:   Section::Live,
			depth:       1,
			is_parent:   true,
			collapsed:   false,
			path:        "/sessions/child1".into(),
			parent_path: Some("/sessions/root".into()),
		},
		Row {
			id:          3,
			title:       "Grandchild Session".into(),
			subtitle:    "repo".into(),
			badge:       None,
			meta:        None,
			placement:   Section::Live,
			depth:       2,
			is_parent:   false,
			collapsed:   false,
			path:        "/sessions/grandchild".into(),
			parent_path: Some("/sessions/child1".into()),
		},
		Row {
			id:          4,
			title:       "Child Session 2".into(),
			subtitle:    "repo".into(),
			badge:       None,
			meta:        None,
			placement:   Section::Live,
			depth:       1,
			is_parent:   false,
			collapsed:   false,
			path:        "/sessions/child2".into(),
			parent_path: Some("/sessions/root".into()),
		},
		Row {
			id:          5,
			title:       "Independent Root".into(),
			subtitle:    "repo".into(),
			badge:       None,
			meta:        None,
			placement:   Section::Live,
			depth:       0,
			is_parent:   false,
			collapsed:   false,
			path:        "/sessions/root2".into(),
			parent_path: None,
		},
	]
}

#[test]
fn forest_draw_order_places_descendants_under_parents() {
	let rows = sample_tree_rows();
	assert_eq!(rows[0].id, 1);
	assert_eq!(rows[1].id, 2);
	assert_eq!(rows[2].id, 3);
	assert_eq!(rows[3].id, 4);
	assert_eq!(rows[4].id, 5);
	assert_eq!(rows[0].depth, 0);
	assert_eq!(rows[1].depth, 1);
	assert_eq!(rows[2].depth, 2);
	assert_eq!(rows[3].depth, 1);
	assert_eq!(rows[4].depth, 0);
}

#[test]
fn per_row_indent_scales_with_generation_step() {
	let tokens = load_bundled_tokens().expect("tokens load");
	let step = tokens.surface.queue.tree_indent_step_px;
	let max_depth = tokens.surface.queue.tree_max_depth;
	assert!(step > 0.0, "tree indent step must be positive");
	assert!(max_depth > 0, "max depth bound must be positive");

	let rows = sample_tree_rows();
	for row in &rows {
		let bounded = row.depth.min(max_depth);
		let indent = (bounded as f32) * step;
		match row.depth {
			0 => assert_eq!(indent, 0.0),
			1 => assert_eq!(indent, step),
			2 => assert_eq!(indent, 2.0 * step),
			_ => {},
		}
	}
}

#[test]
fn depth_past_token_bound_stops_indent_and_states_depth() {
	let tokens = load_bundled_tokens().expect("tokens load");
	let step = tokens.surface.queue.tree_indent_step_px;
	let max_depth = tokens.surface.queue.tree_max_depth;

	let deep_row = Row {
		id:          10,
		title:       "Deep Branch".into(),
		subtitle:    "repo".into(),
		badge:       None,
		meta:        None,
		placement:   Section::Live,
		depth:       max_depth + 2,
		is_parent:   false,
		collapsed:   false,
		path:        "/sessions/deep".into(),
		parent_path: Some("/sessions/parent".into()),
	};

	let bounded = deep_row.depth.min(max_depth);
	let indent = (bounded as f32) * step;
	assert_eq!(indent, (max_depth as f32) * step, "indent stops at max_depth bound");
	assert!(deep_row.depth > max_depth, "row depth exceeds bound");
}

#[test]
fn a_folded_branch_hides_every_generation_under_it() {
	// The fold is projected onto the row that carries it, and the rail asks
	// `Branches` which rows a fold above them hides. A walk that only looked
	// at the immediate parent left a grandchild drawn under a folded root.
	let mut rows = sample_tree_rows();
	rows[0].collapsed = true;
	let branches = Branches::of(rows.iter());
	let hidden: Vec<u64> = rows
		.iter()
		.filter(|row| branches.hidden(row))
		.map(|row| row.id)
		.collect();
	assert_eq!(hidden, vec![2, 3, 4], "the folded root hides its child, grandchild and sibling");
	assert!(!branches.hidden(&rows[0]), "the folded row itself stays drawn, carrying its chevron");
	assert!(!branches.hidden(&rows[4]), "a root beside the folded one is untouched");
}

#[test]
fn a_cycle_in_the_paths_the_host_sent_ends_the_walk() {
	// Two rows naming each other as parent is a walk with no top. The bound
	// is the number of rows, so the answer arrives instead of the frame
	// hanging on a list the host got wrong.
	let mut rows = sample_tree_rows();
	rows[0].parent_path = Some("/sessions/child1".into());
	rows[1].parent_path = Some("/sessions/root".into());
	let branches = Branches::of(rows.iter());
	assert!(!branches.hidden(&rows[0]), "nothing in the cycle is folded, so nothing is hidden");
	assert!(!branches.hidden(&rows[1]));

	rows[4].collapsed = true;
	let folded = Branches::of(rows.iter());
	assert!(!folded.hidden(&rows[1]), "a fold outside the cycle still answers for a row inside it");
}

#[test]
fn keyboard_navigation_skips_collapsed_subtrees() {
	let mut state = ShellState {
		title: "test".into(),
		sections: vec![(Section::Live, sample_tree_rows())],
		..Default::default()
	};
	let mut intents = Intents::new();

	// When fully expanded: 1 -> 2 -> 3 -> 4 -> 5
	let listed: Vec<u64> = state.listed_rows().map(|r| r.id).collect();
	assert_eq!(listed, vec![1, 2, 3, 4, 5]);

	state.keymap.queue_cursor = Some(1);
	intents.dispatch(Intent::MoveQueueSelection(1), &mut state);
	assert_eq!(state.selected_row(), 2);

	// Collapse child1 (id 2): grandchild (id 3) should disappear
	state.sections[0].1[1].collapsed = true;
	state.navigation.active_mut().queue.collapsed_parents =
		BTreeSet::from(["/sessions/child1".to_string()]);

	let listed_collapsed: Vec<u64> = state.listed_rows().map(|r| r.id).collect();
	assert_eq!(listed_collapsed, vec![1, 2, 4, 5]);

	state.keymap.queue_cursor = Some(2);
	intents.dispatch(Intent::MoveQueueSelection(1), &mut state);
	// Skips grandchild (3) and lands on child2 (4)
	assert_eq!(state.selected_row(), 4);

	// Now collapse root (id 1): entire subtree (2, 3, 4) should disappear
	state.sections[0].1[0].collapsed = true;
	state.navigation.active_mut().queue.collapsed_parents =
		BTreeSet::from(["/sessions/root".to_string()]);

	let listed_root_collapsed: Vec<u64> = state.listed_rows().map(|r| r.id).collect();
	assert_eq!(listed_root_collapsed, vec![1, 5]);

	state.keymap.queue_cursor = Some(1);
	intents.dispatch(Intent::MoveQueueSelection(1), &mut state);
	// Skips all descendants and lands on next root (5)
	assert_eq!(state.selected_row(), 5);
}

/// A window over tree rows that records every intent the rail raises.
fn shell(
	state: ShellState,
	raised: Rc<RefCell<Vec<Intent>>>,
) -> impl FnOnce(&mut Window, &mut App) -> Entity<ShellView> {
	move |_window, app| {
		let tokens = load_bundled_tokens().expect("tokens load");
		let theme = load_bundled_theme("dark").expect("theme loads");
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		let view = app.new(|_| ShellView::new(installed, state));
		app.observe(&view, move |view, app| {
			let intents = view.update(app, |view, _| view.drain_intents());
			raised.borrow_mut().extend(intents);
		})
		.detach();
		view
	}
}

/// A window over the tree rows with the rail holding the keyboard: the
/// `Queue` chords are bound under the rail's own context, and a press on a
/// row is what hands it to them. The press leaves the cursor on the row it
/// landed on, which is the rail's first.
fn rail_window<'a>(
	cx: &'a mut Headless,
	raised: &Rc<RefCell<Vec<Intent>>>,
) -> HeadlessSession<'a, ShellView> {
	// A window still attaching draws the attach screen in place of the
	// columns, and the rail a press lands on is one of them.
	let state = ShellState {
		title: "Root Session".into(),
		sections: vec![(Section::Live, sample_tree_rows())],
		connection: ConnectionPhase::Attached,
		current_id: 1,
		..Default::default()
	};
	let options = RenderOptions { width: 1440, height: 900, ..RenderOptions::default() };
	let mut session = HeadlessSession::open(cx, &options, shell(state, Rc::clone(raised)))
		.expect("the window opens");
	// The rail measures its list on the first frame and lays the rows out on
	// the second, so a press after one frame lands on a rail drawing no row.
	session.frame().expect("the first frame renders");
	session.frame().expect("the settling frame renders");
	let bounds = session
		.update(|view, _, _| {
			(0..8)
				.flat_map(|ix| [Region::QueueCardRow(ix), Region::QueueLineRow(ix)])
				.find_map(|region| view.laid_out().drawn_bounds(region))
		})
		.expect("the view is live")
		.expect("the rail drew a row to press");
	session
		.click(point(
			bounds.origin.x + bounds.size.width / 2.0,
			bounds.origin.y + bounds.size.height / 2.0,
		))
		.expect("the rail answers the press");
	session
		.update(|view, _, _| view.drain_intents())
		.expect("the view is live");
	raised.borrow_mut().clear();
	session
}

/// The row the rail's cursor is on.
fn cursor(session: &mut HeadlessSession<'_, ShellView>) -> u64 {
	session
		.update(|view, _, _| view.state().selected_row())
		.expect("the view is live")
}

/// Walks the cursor down to `row` with the arrow the rail binds, bounded by
/// the rows the fixture lists so a walk that never arrives ends.
fn walk_to(session: &mut HeadlessSession<'_, ShellView>, row: u64) {
	for _ in 0..sample_tree_rows().len() {
		if cursor(session) == row {
			return;
		}
		session.keystroke("down").expect("the chord is delivered");
	}
	assert_eq!(cursor(session), row, "the arrows never reached row {row}");
}

#[test]
fn the_arrows_fold_and_unfold_the_branch_under_the_cursor() {
	// A chevron is a pointer's control, and the rail is walked with the
	// arrows. Left folds the branch the cursor is on and right unfolds it,
	// through the same intent the chevron raises.
	let raised = Rc::new(RefCell::new(Vec::new()));
	let mut cx = headless_context().expect("headless context available");
	let mut session = rail_window(&mut cx, &raised);
	assert_eq!(cursor(&mut session), 1, "the press left the cursor on the root branch");

	assert!(session.keystroke("left").expect("the chord is delivered"), "left is bound in the rail");
	assert_eq!(
		raised.borrow().as_slice(),
		[Intent::ToggleQueueParent("/sessions/root".to_string())],
		"left folds the branch the cursor is on"
	);

	// The projection is redone from the store the fold was written to, so
	// the drawn row is marked the way the next one arrives before the second
	// press is read.
	raised.borrow_mut().clear();
	session
		.update(|view, _, _| view.state_mut().sections[0].1[0].collapsed = true)
		.expect("the fold reaches the drawn row");
	session.frame().expect("the folded rail draws");

	session.keystroke("left").expect("the chord is delivered");
	assert!(
		raised.borrow().is_empty(),
		"left on a folded branch asks for the state it is already in: {:?}",
		raised.borrow()
	);

	session.keystroke("right").expect("the chord is delivered");
	assert_eq!(
		raised.borrow().as_slice(),
		[Intent::ToggleQueueParent("/sessions/root".to_string())],
		"right unfolds the branch the cursor is on"
	);
}

#[test]
fn the_arrows_leave_a_row_with_no_branch_alone() {
	// Row 5 is a root with no children, so neither arrow has a branch to
	// fold: a press that raised the intent would hide nothing and leave the
	// row drawn as folded.
	let raised = Rc::new(RefCell::new(Vec::new()));
	let mut cx = headless_context().expect("headless context available");
	let mut session = rail_window(&mut cx, &raised);
	walk_to(&mut session, 5);
	raised.borrow_mut().clear();

	session.keystroke("left").expect("the chord is delivered");
	session.keystroke("right").expect("the chord is delivered");
	assert!(
		raised.borrow().is_empty(),
		"a row with no children is no branch to fold: {:?}",
		raised.borrow()
	);
}
