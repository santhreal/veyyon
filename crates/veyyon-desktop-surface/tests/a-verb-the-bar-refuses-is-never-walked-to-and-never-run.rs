//! WHY: a verb the host cannot take was reachable in the bar as if it could
//! be. The menu draws it, the keyboard could stand on it, and Return would
//! dispatch it -- a window asking a host for something it has already said it
//! cannot do.
//!
//! CLASS CLOSED: every way a refused verb can be reached from the bar. An
//! opening menu stands on the first entry that is offered, the walk crosses
//! the whole section in both directions without standing on a refused one, a
//! press on a refused row is spent on the refusal rather than on a dismissal,
//! and a verb withdrawn under a standing keyboard is refused by the run gate,
//! which is the single place a refusal is enforced.
//!
//! GAPS: the refusals are seeded here rather than projected from a host, which
//! `a-verb-the-host-declined-is-refused-in-the-menu-and-dropped-from-the-palette`
//! covers; how the refused row is drawn is
//! `a-row-a-menu-draws-is-readable-on-the-ground-it-draws-on`'s.

use veyyon_desktop_surface::{Command, MenuSectionId};
use veyyon_gpui::{Point, px};

#[path = "support/menu-bar/mod.rs"]
mod support;

use support::{drawn_once, render_session};

#[test]
fn a_declined_verb_is_never_walked_to_and_never_taken() {
	// The rail toggle is the first entry of `View`; declined, the walk has to
	// start below it and Return must never reach it.
	render_session(&[Command::ToggleQueue], |session| {
		let captured = session.frame().expect("frame renders");
		let at = drawn_once(&captured, MenuSectionId::View.title());
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("open the View menu");
		let standing = session
			.update(|view, _window, _cx| view.state().menu.highlighted_command())
			.expect("read the walk");
		assert_eq!(
			standing,
			Some(Command::TogglePanel),
			"a menu whose first entry is declined opens on the first one that is offered"
		);

		// Walking the whole section in both directions must never stand on the
		// declined entry. The walk wraps, so each direction reaches the first
		// entry from the other side of the section.
		for step in ["down", "up"] {
			for _ in 0..MenuSectionId::View.entries().len() + 2 {
				session.keystroke(step).expect("walk the section");
				let on = session
					.update(|view, _window, _cx| view.state().menu.highlighted_command())
					.expect("read the walk");
				assert_ne!(
					on,
					Some(Command::ToggleQueue),
					"walking {step} never stands on a declined entry, so Return always has something \
					 to take"
				);
			}
		}
	});
}

#[test]
fn pressing_a_declined_entry_does_nothing_and_leaves_the_menu_open() {
	render_session(&[Command::ToggleQueue], |session| {
		let captured = session.frame().expect("frame renders");
		let at = drawn_once(&captured, MenuSectionId::View.title());
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("open the View menu");
		let captured = session.frame().expect("the open menu renders");
		let row = drawn_once(&captured, Command::ToggleQueue.label());
		let before = session
			.update(|view, _window, _cx| view.state().keymap.queue_collapsed)
			.expect("read the rail");
		session
			.click(Point { x: px(row.x), y: px(row.y) })
			.expect("press the declined row");
		let (open, after) = session
			.update(|view, _window, _cx| (view.state().menu.open, view.state().keymap.queue_collapsed))
			.expect("read the window");
		assert_eq!(after, before, "a declined entry answers no press");
		assert_eq!(
			open,
			Some(MenuSectionId::View),
			"the card takes the press rather than passing it to the scrim, so a dead row is a dead \
			 press and not a dismissal"
		);
	});
}

#[test]
fn a_verb_withdrawn_under_the_keyboard_is_not_taken_by_return() {
	// The projection rewrites the refused set on every frame it draws, so a
	// capability the host withdraws while the bar is open leaves the keyboard
	// standing on an entry that can no longer be taken. That is the one state
	// the walk's own skipping cannot produce, and the run gate is what refuses
	// it: a refusal there is not a dismissal either, since the menu stays open
	// to walk on.
	render_session(&[], |session| {
		let captured = session.frame().expect("frame renders");
		let at = drawn_once(&captured, MenuSectionId::View.title());
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("open the View menu");
		let standing = session
			.update(|view, _window, _cx| view.state().menu.highlighted_command())
			.expect("read the walk");
		assert_eq!(
			standing,
			Some(Command::ToggleQueue),
			"a menu with nothing declined opens on its first entry"
		);

		let before = session
			.update(|view, _window, _cx| {
				view.state_mut().menu.declined.push(Command::ToggleQueue);
				view.state().keymap.queue_collapsed
			})
			.expect("withdraw the verb the keyboard stands on");
		session.keystroke("enter").expect("press Return on it");
		let (collapsed, open) = session
			.update(|view, _window, _cx| (view.state().keymap.queue_collapsed, view.state().menu.open))
			.expect("read the window");
		assert_eq!(collapsed, before, "a verb the host withdrew is not run by Return");
		assert_eq!(
			open,
			Some(MenuSectionId::View),
			"a refused Return is spent on the refusal: the menu is still open to walk on"
		);
	});
}
