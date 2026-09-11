//! WHY: the detail popover was built for the workspace tree row and the other
//! two controls that cut what they know -- the composer's model chip and a diff
//! hunk header -- were left stating nothing. A mechanism wired to the case
//! someone had in mind and not to its siblings is the recurring defect here.
//!
//! CLASS CLOSED: a `DetailSource` with no control that opens it, one whose
//! control opens a popover that states no fact, one whose facts are invented
//! rather than read out of the state the same frame draws from, and one drawn
//! outside the window it is anchored in. The source list is swept from
//! `DetailSource::iter()` at run time, so a fourth source is red here until it
//! has a control, a fixture payload and a fact, and every arm presses the run
//! the frame reported.
//!
//! NOT CAUGHT: dismissal, focus and placement, which the pointer suite owns;
//! the wording of each fact beyond its first, which is prose; and a payload the
//! host never sent, which no control can be pressed to open.

#[allow(dead_code, reason = "this binary uses a subset of the shared detail helpers")]
#[path = "support/detail/mod.rs"]
mod detail;

use detail::{
	FILE_PATH, along, control_label, detail_for, open_window, run_labelled, runs_inside_window,
	runs_labelled, settled_frame, state_on, stated_fact, tab_for,
};
use strum::IntoEnumIterator;
use veyyon_desktop_surface::{DetailKind, DetailSource, PanelTab, detail_facts};
use veyyon_gpui::{Pixels, Point, px};

#[test]
fn every_source_has_a_control_a_secondary_press_opens_its_detail_from() {
	for source in DetailSource::iter() {
		open_window(state_on(tab_for(source)), |session| {
			let first = session.frame().expect("the shell draws its first frame");
			let label = control_label(source);
			let control = run_labelled(&first, label);

			session
				.right_click(along(control, 0.5))
				.expect("the secondary press reaches the control");
			let opened = session.frame().expect("the popover draws a frame");

			let open = session
				.update(|view, _window, _cx| view.detail().cloned())
				.expect("the view's state is read")
				.unwrap_or_else(|| panic!("{source:?}: pressing {label:?} opened no detail"));
			assert_eq!(
				open.kind.source(),
				source,
				"{source:?}: pressing {label:?} opened a detail from another source"
			);

			let (fact, value) = stated_fact(source);
			assert_eq!(
				runs_labelled(&opened, fact),
				1,
				"{source:?}: the popover states {fact:?} once"
			);
			assert!(
				runs_labelled(&opened, value) >= 1,
				"{source:?}: the popover states the value {value:?} its state holds"
			);
			assert!(
				runs_inside_window(&opened, fact),
				"{source:?}: the popover drew {fact:?} outside the window"
			);
		});
	}
}

#[test]
fn every_source_states_at_least_two_facts_read_out_of_the_state_the_frame_draws_from() {
	let state = state_on(PanelTab::Diff);
	for source in DetailSource::iter() {
		let kind = detail_for(source, Point { x: px(0.0), y: px(0.0) }).kind;
		let facts = detail_facts(&kind, &state)
			.unwrap_or_else(|| panic!("{source:?}: states nothing about {kind:?}"));
		assert!(
			!facts.heading.is_empty(),
			"{source:?}: the popover has no heading to say what it is about"
		);
		assert!(
			facts.rows.len() >= 2,
			"{source:?}: a popover worth opening states more than one fact, states {}",
			facts.rows.len()
		);
		let (label, value) = stated_fact(source);
		let row = facts
			.rows
			.iter()
			.find(|row| row.label == label)
			.unwrap_or_else(|| panic!("{source:?}: states no {label:?}"));
		assert_eq!(
			row.value, value,
			"{source:?}: {label:?} is read out of the state the frame draws from"
		);
	}
}

#[test]
fn a_payload_the_state_no_longer_holds_states_nothing_rather_than_an_empty_card() {
	let state = state_on(PanelTab::Diff);
	let gone: [DetailKind; 3] = [
		DetailKind::TreeRow("crates/gone.rs".to_owned()),
		// The row index of a context line, which is in the file and is not a
		// hunk header.
		DetailKind::DiffHunk { path: FILE_PATH.to_owned(), row: 1 },
		DetailKind::DiffHunk { path: "crates/gone.rs".to_owned(), row: 0 },
	];
	for kind in gone {
		assert!(
			detail_facts(&kind, &state).is_none(),
			"{kind:?}: a payload the state does not hold states nothing"
		);
	}

	let mut without_model = state_on(PanelTab::Diff);
	without_model.composer.model = None;
	assert!(
		detail_facts(&DetailKind::Model, &without_model).is_none(),
		"a session with no model to name states nothing about one"
	);
}

/// A file's own totals cover every hunk in it, so a popover that reported them
/// would say the same figure over each header and tell the operator nothing
/// about the hunk under the pointer.
#[test]
fn a_hunk_states_the_lines_it_changed_rather_than_its_file_totals() {
	let state = state_on(PanelTab::Diff);
	let kind = DetailKind::DiffHunk { path: FILE_PATH.to_owned(), row: 0 };
	let facts = detail_facts(&kind, &state).expect("the fixture's hunk states facts");
	let changed = facts
		.rows
		.iter()
		.find(|row| row.label == "Changed")
		.expect("the hunk states what it changed");
	assert_eq!(
		changed.value, "+1 -1",
		"the file the host reported changes 12 lines and 3, and this hunk changes one of each"
	);
}

#[test]
fn a_popover_open_on_a_row_the_host_withdrew_goes_rather_than_stating_a_stale_fact() {
	open_window(state_on(PanelTab::Tree), |session| {
		let first = session.frame().expect("the shell draws its first frame");
		let row = along(run_labelled(&first, detail::FILE_NAME), 0.5);
		session
			.right_click(row)
			.expect("the press opens the popover");
		let opened = session.frame().expect("the popover draws a frame");
		assert_eq!(runs_labelled(&opened, FILE_PATH), 1, "the popover states the path");

		// The tree the frame draws from no longer holds that row, which is
		// what a checkout or a refresh leaves under an open popover.
		session
			.update(|view, _window, cx| {
				view
					.state_mut()
					.panel
					.tree
					.rows
					.retain(|row| row.path != FILE_PATH);
				cx.notify();
			})
			.expect("the snapshot is applied");

		let after = settled_frame(session);
		assert_eq!(
			runs_labelled(&after, FILE_PATH),
			0,
			"the popover states nothing about a row the snapshot no longer holds"
		);
	});
}

/// A source's control is pressed at a point the frame reported, so this is the
/// one place the suite states a coordinate of its own: a press that lands on
/// nothing must open nothing.
#[test]
fn a_secondary_press_on_the_ground_between_controls_opens_no_detail() {
	open_window(state_on(PanelTab::Tree), |session| {
		session.frame().expect("the shell draws its first frame");
		let empty: Point<Pixels> = Point { x: px(200.0), y: px(400.0) };
		session.right_click(empty).expect("the press dispatches");
		session.frame().expect("the frame after the press");
		assert!(
			session
				.update(|view, _window, _cx| view.detail().is_none())
				.expect("the view's state is read"),
			"a secondary press on the transcript opened a detail popover"
		);
	});
}
