//! WHY: the workspace tree drew a file's name inside a panel narrower than its
//! path, the composer's chip drew a model's display name and nothing the
//! catalogue said about it, and a hunk header drew a truncated symbol with its
//! file's own header scrolled away. Each had the rest in state and nowhere to
//! put it, so a secondary press on any of them stated nothing at all.
//!
//! CLASS CLOSED: a detail surface that states nothing the control had not
//! already drawn, one that cannot be dismissed by the two gestures every float
//! in this window answers, one that leaves the keystrokes of the surface
//! underneath reaching it while it is open, one that drops the focus on the
//! floor when it closes, one anchored at a control on the window's bottom row
//! that grows off the bottom edge, and an exit that never ends. Every arm
//! presses the run the frame reported, so a popover that never reached the
//! frame fails here.
//!
//! NOT CAUGHT: which facts each source states, and that every source states
//! any, which the sweep suite owns; the corner arithmetic on each axis, which
//! the kit suite owns; the transition's own shape, which the float suite drives
//! against a synthetic clock; and the pointer reaching a row the panel has
//! scrolled, which the panel suites own. Nor the popover's own `track_focus`:
//! the shell takes the window's focus when it opens the popover, so a build
//! that never tracked the handle on the card traps the keyboard just the same,
//! and every arm here reads the same.

#[allow(dead_code, reason = "this binary uses a subset of the shared detail helpers")]
#[path = "support/detail/mod.rs"]
mod detail;

use detail::{
	FILE_NAME, FILE_PATH, HEIGHT, MODEL_NAME, WIDTH, along, open_window, run_labelled,
	runs_inside_window, runs_labelled, settled_frame, state_on,
};
use veyyon_desktop_surface::{Detail, DetailKind, PanelTab};
use veyyon_gpui::{Point, px};

/// A draft long enough to tell a keystroke that reached the composer from one
/// that did not.
const DRAFT: &str = "steer";

/// A point in the transcript the operator was reading, which is well clear of
/// the panel the popover is anchored in.
const fn outside() -> Point<veyyon_gpui::Pixels> {
	Point { x: px(200.0), y: px(400.0) }
}

#[test]
fn a_secondary_press_on_a_tree_row_states_the_path_the_row_drew_the_end_of() {
	open_window(state_on(PanelTab::Tree), |session| {
		let first = session.frame().expect("the shell draws its first frame");
		assert_eq!(
			runs_labelled(&first, FILE_PATH),
			0,
			"the tree draws the row's name, so nothing on this frame states the path whole"
		);
		let row = along(run_labelled(&first, FILE_NAME), 0.5);

		session
			.right_click(row)
			.expect("the secondary press reaches the row");
		let opened = session.frame().expect("the popover draws a frame");

		assert_eq!(runs_labelled(&opened, FILE_PATH), 1, "the popover states the path the row cut");
		for label in ["Path", "Kind", "Changed"] {
			assert_eq!(runs_labelled(&opened, label), 1, "the popover states {label:?} once");
		}
		assert_eq!(
			runs_labelled(&opened, "+12 -3"),
			1,
			"the popover states what the host said changed in the file"
		);
	});
}

/// The popover the tree row opens grows down and right from the press, so it
/// covers the row it belongs to and the second press lands on the card. The
/// chip's grows up, which leaves the control reachable, and that is where a
/// second press is a second press rather than a press inside the popover.
#[test]
fn a_second_press_on_a_control_the_popover_does_not_cover_closes_it() {
	open_window(state_on(PanelTab::Diff), |session| {
		let first = session.frame().expect("the shell draws its first frame");
		let chip = along(run_labelled(&first, MODEL_NAME), 0.5);

		session
			.right_click(chip)
			.expect("the first press opens the popover");
		session.frame().expect("the popover draws a frame");
		assert!(
			session
				.update(|view, _window, _cx| view.detail().is_some())
				.expect("the view's state is read"),
			"the first press opened a popover"
		);

		session
			.right_click(chip)
			.expect("the second press reaches the same chip");
		assert!(
			session
				.update(|view, _window, _cx| view.detail().is_none())
				.expect("the view's state is read"),
			"a second press on the control that opened the popover closes it"
		);
		let closed = settled_frame(session);
		assert_eq!(runs_labelled(&closed, "Provider"), 0, "the closed popover states nothing");
	});
}

#[test]
fn a_press_outside_the_popover_dismisses_it_and_so_does_escape() {
	for dismissal in ["press", "escape"] {
		open_window(state_on(PanelTab::Tree), |session| {
			let first = session.frame().expect("the shell draws its first frame");
			let row = along(run_labelled(&first, FILE_NAME), 0.5);
			session
				.right_click(row)
				.expect("the press opens the popover");
			session.frame().expect("the popover draws a frame");

			if dismissal == "press" {
				session
					.click(outside())
					.expect("the press lands outside the popover");
			} else {
				assert!(
					session.keystroke("escape").expect("the chord dispatches"),
					"{dismissal}: the shell answers escape while a popover is open"
				);
			}

			assert!(
				session
					.update(|view, _window, _cx| view.detail().is_none())
					.expect("the view's state is read"),
				"{dismissal}: the popover is dismissed"
			);
			// The exit is a fade against the wall clock, so the bound matters
			// as much as the value: the popover is gone within it, rather than
			// drawn for as long as the window is open.
			let after = settled_frame(session);
			assert_eq!(
				runs_labelled(&after, FILE_PATH),
				0,
				"{dismissal}: the dismissed popover states nothing once its exit has run"
			);
			assert_eq!(
				runs_labelled(&after, FILE_NAME),
				1,
				"{dismissal}: the row the popover was opened from is still drawn"
			);
		});
	}
}

#[test]
fn the_popover_holds_the_keyboard_while_it_is_open_and_gives_it_back_when_it_closes() {
	open_window(state_on(PanelTab::Tree), |session| {
		let first = session.frame().expect("the shell draws its first frame");
		let row = along(run_labelled(&first, FILE_NAME), 0.5);

		session.type_text(DRAFT).expect("the draft is typed");
		assert_eq!(
			session
				.update(|view, _window, _cx| view.composer_text().to_owned())
				.expect("the draft is read"),
			DRAFT,
			"the composer holds the keyboard before the press"
		);

		session
			.right_click(row)
			.expect("the press opens the popover");
		session.frame().expect("the popover draws a frame");
		session.type_text("xyz").expect("the keystrokes dispatch");
		assert_eq!(
			session
				.update(|view, _window, _cx| view.composer_text().to_owned())
				.expect("the draft is read"),
			DRAFT,
			"the popover holds the keyboard, so the composer under it took nothing"
		);

		session.keystroke("escape").expect("the chord dispatches");
		session.frame().expect("the frame after the dismissal");
		session.type_text("!").expect("the keystroke dispatches");
		assert_eq!(
			session
				.update(|view, _window, _cx| view.composer_text().to_owned())
				.expect("the draft is read"),
			format!("{DRAFT}!"),
			"closing the popover gives the keyboard back to what held it"
		);
	});
}

/// A press on any of the three controls lands outside the editor and blurs the
/// draft on its own, so no arm that presses can tell a popover that took the
/// keyboard from a press that took it first. This one opens the detail through
/// the shell's own entry point with the draft still holding the keyboard, which
/// leaves the popover as the only thing that can take it.
#[test]
fn opening_a_detail_takes_the_keyboard_off_whatever_was_holding_it() {
	open_window(state_on(PanelTab::Diff), |session| {
		session.frame().expect("the shell draws its first frame");
		session.type_text(DRAFT).expect("the draft is typed");

		session
			.update(|view, window, cx| {
				view.open_detail(Detail::above(DetailKind::Model, outside()), window, cx);
			})
			.expect("the detail opens");
		session.frame().expect("the popover draws a frame");

		session.type_text("xyz").expect("the keystrokes dispatch");
		assert_eq!(
			session
				.update(|view, _window, _cx| view.composer_text().to_owned())
				.expect("the draft is read"),
			DRAFT,
			"the popover took the keyboard off the draft that was holding it"
		);

		session.keystroke("escape").expect("the chord dispatches");
		session.frame().expect("the frame after the dismissal");
		session.type_text("!").expect("the keystroke dispatches");
		assert_eq!(
			session
				.update(|view, _window, _cx| view.composer_text().to_owned())
				.expect("the draft is read"),
			format!("{DRAFT}!"),
			"the dismissal gave the keyboard back to the draft it took it from"
		);
	});
}

#[test]
fn the_popover_a_control_on_the_bottom_row_opens_grows_up_and_stays_inside_the_window() {
	open_window(state_on(PanelTab::Diff), |session| {
		let first = session.frame().expect("the shell draws its first frame");
		let chip = run_labelled(&first, MODEL_NAME);
		let chip_top = f32::from(chip.origin.y);
		assert!(
			chip_top > f32::from(HEIGHT) * 0.75,
			"the chip is on the window's bottom row, drew at {chip_top}"
		);

		session
			.right_click(along(chip, 0.5))
			.expect("the secondary press reaches the chip");
		let opened = session.frame().expect("the popover draws a frame");

		let provider = run_labelled(&opened, "Provider");
		assert!(
			f32::from(provider.origin.y) < chip_top,
			"the popover grew up from a chip at {chip_top}, drew its first fact at {}",
			f32::from(provider.origin.y)
		);
		for label in ["Provider", "Identifier", "Reasoning", "Accepts"] {
			assert!(
				runs_inside_window(&opened, label),
				"the popover drew {label:?} outside the window it was anchored in"
			);
		}
	});
}

#[test]
fn the_popover_stays_where_it_opened_under_reduced_motion() {
	open_window(state_on(PanelTab::Tree), |session| {
		let first = session.frame().expect("the shell draws its first frame");
		let row = along(run_labelled(&first, FILE_NAME), 0.5);

		session
			.right_click(row)
			.expect("the press opens the popover");
		let opened = session.frame().expect("the popover draws a frame");
		let pressed = run_labelled(&opened, FILE_PATH);

		let settled = settled_frame(session);
		let after = run_labelled(&settled, FILE_PATH);
		assert_eq!(
			(f32::from(pressed.origin.x), f32::from(pressed.origin.y)),
			(f32::from(after.origin.x), f32::from(after.origin.y)),
			"reduced motion fades the popover in without moving it, so the facts are readable at the \
			 place they will stay"
		);
	});
}

/// A tree row is full width, so a press near its right end is a press on the
/// row, and the card asked for grows right from a point with no room for it.
///
/// A card flipped to the other side of the press leaves the press on its edge
/// and the row underneath still answering; a card dragged back inside the
/// window instead covers the point it was opened at, which is the placement
/// this asserts against by pressing the same point again.
#[test]
fn a_popover_opened_at_the_far_end_of_its_row_is_placed_beside_the_press_not_across_it() {
	open_window(state_on(PanelTab::Tree), |session| {
		let first = session.frame().expect("the shell draws its first frame");
		let row = run_labelled(&first, FILE_NAME);
		// Inside the panel's right edge, past every trailing control the row
		// draws, which is ground the row itself answers for.
		let edge = Point { x: px(f32::from(WIDTH) - 24.0), y: row.origin.y + row.size.height / 2.0 };

		session
			.right_click(edge)
			.expect("the press reaches the row");
		let opened = session.frame().expect("the popover draws a frame");
		assert!(
			session
				.update(|view, _window, _cx| view.detail().is_some())
				.expect("the view's state is read"),
			"the press at the row's far end opened the row's detail"
		);
		for label in ["Path", "Kind", "Changed", FILE_PATH] {
			assert!(
				runs_inside_window(&opened, label),
				"the popover drew {label:?} outside the window it was anchored in"
			);
		}

		session
			.right_click(edge)
			.expect("the second press dispatches");
		assert!(
			session
				.update(|view, _window, _cx| view.detail().is_none())
				.expect("the view's state is read"),
			"the popover was placed across the press, so the row no longer answers one"
		);
	});
}
