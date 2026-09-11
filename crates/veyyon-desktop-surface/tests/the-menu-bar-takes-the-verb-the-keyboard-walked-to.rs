//! WHY: a menu table that lists the right verbs proves nothing about a bar an
//! operator can use. The reachability sweep reads the table; this drives the
//! real `ShellView` in a headless window: it presses the words the titlebar
//! drew, walks the open menu with the arrows, takes an entry with Return, and
//! checks that a verb the host declined answers neither.
//!
//! CLASS CLOSED: the bar's own behaviour, over every section from
//! `MenuSectionId::iter()` rather than one written here. Each word is located
//! by the text the frame recorded drawing and required to sit in a hitbox of
//! its own; pressing it opens that section and pressing it again closes it;
//! Escape closes whichever is open and hands the keyboard back to the
//! composer it took it from; the arrows walk entries and sections; Return
//! dispatches the gpui action the same chord dispatches, which is observed as
//! the state change the verb makes rather than as a call that was made. A
//! section added to the bar is swept the moment it exists.
//!
//! GAPS: it drives the bar, not every verb behind it. What each verb does is
//! the suite for that verb. A verb the host declined is
//! `a-verb-the-bar-refuses-is-never-walked-to-and-never-run`'s, and the
//! refusals it seeds are projected from a host by
//! `a-verb-the-host-declined-is-refused-in-the-menu-and-dropped-from-the-palette`
//! covers; the window and process lifecycle the `Veyyon` menu reaches is
//! `closing-the-window-ends-the-process-only-when-nothing-can-reopen`.

use strum::IntoEnumIterator;
use veyyon_desktop_surface::{Command, Intent, MenuSectionId};
use veyyon_gpui::{Point, px};

#[path = "support/menu-bar/mod.rs"]
mod support;

use support::{drawn_once, hit, render_session};

#[test]
fn every_word_the_bar_draws_is_a_control() {
	render_session(&[], |session| {
		let captured = session.frame().expect("frame renders");
		for section in MenuSectionId::iter() {
			let at = drawn_once(&captured, section.title());
			assert!(
				hit(&captured, at),
				"the bar draws `{title}` at {at:?} with no hitbox over it, so a press on it does \
				 nothing",
				title = section.title(),
			);
		}
	});
}

#[test]
fn pressing_a_word_opens_that_menu_and_pressing_it_again_closes_it() {
	for section in MenuSectionId::iter() {
		render_session(&[], |session| {
			let captured = session.frame().expect("frame renders");
			let at = drawn_once(&captured, section.title());
			session
				.click(Point { x: px(at.x), y: px(at.y) })
				.expect("press the word the bar drew");
			let open = session
				.update(|view, _window, _cx| view.state().menu.open)
				.expect("read the bar");
			assert_eq!(open, Some(section), "pressing `{}` opens it", section.title());

			session
				.click(Point { x: px(at.x), y: px(at.y) })
				.expect("press the same word again");
			let open = session
				.update(|view, _window, _cx| view.state().menu.open)
				.expect("read the bar");
			assert_eq!(open, None, "pressing `{}` again closes it", section.title());
		});
	}
}

#[test]
fn the_open_menu_draws_every_entry_it_holds() {
	for section in MenuSectionId::iter() {
		render_session(&[], |session| {
			let captured = session.frame().expect("frame renders");
			let at = drawn_once(&captured, section.title());
			session
				.click(Point { x: px(at.x), y: px(at.y) })
				.expect("open the menu");
			let captured = session.frame().expect("the open menu renders");
			let drawn: Vec<String> = captured
				.text_runs
				.iter()
				.map(|run| run.text.as_ref().trim().to_owned())
				.collect();
			for command in section.entries() {
				assert!(
					drawn.iter().any(|text| text == command.label()),
					"{title} is open and does not draw `{label}`",
					title = section.title(),
					label = command.label(),
				);
			}
		});
	}
}

#[test]
fn escape_closes_the_open_menu_and_leaves_the_surface_under_it() {
	render_session(&[], |session| {
		let captured = session.frame().expect("frame renders");
		let at = drawn_once(&captured, MenuSectionId::View.title());
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("open the View menu");
		let collapsed = session
			.update(|view, _window, _cx| view.state().keymap.queue_collapsed)
			.expect("read the rail");
		session.keystroke("escape").expect("press escape");
		let (open, still_collapsed) = session
			.update(|view, _window, _cx| (view.state().menu.open, view.state().keymap.queue_collapsed))
			.expect("read the bar");
		assert_eq!(open, None, "escape closes the open menu");
		assert_eq!(
			still_collapsed, collapsed,
			"the press that closed the menu left the rail as it was: one rung per press"
		);
	});
}

#[test]
fn return_takes_the_entry_the_arrows_walked_to() {
	// `View` holds the rail toggle first and the panel toggle second, so one
	// step down and Return is observed as the panel opening rather than as a
	// call this test made.
	render_session(&[], |session| {
		let captured = session.frame().expect("frame renders");
		let at = drawn_once(&captured, MenuSectionId::View.title());
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("open the View menu");
		let first = session
			.update(|view, _window, _cx| view.state().menu.highlighted)
			.expect("read the walk");
		assert_eq!(first, 0, "an opened menu stands on its first offered entry");

		session.keystroke("down").expect("walk one entry down");
		let walked = session
			.update(|view, _window, _cx| view.state().menu.highlighted_command())
			.expect("read the walk");
		assert_eq!(
			walked,
			Some(Command::TogglePanel),
			"one step down from the rail toggle stands on the panel toggle"
		);

		session.keystroke("enter").expect("take the entry");
		let (open, panel_collapsed) = session
			.update(|view, _window, _cx| (view.state().menu.open, view.state().keymap.panel_collapsed))
			.expect("read the window");
		assert_eq!(open, None, "taking an entry closes the bar");
		assert!(!panel_collapsed, "taking the panel toggle opened the panel");
	});
}

#[test]
fn the_arrows_walk_the_bar_from_the_menu_they_opened() {
	render_session(&[], |session| {
		let captured = session.frame().expect("frame renders");
		let at = drawn_once(&captured, MenuSectionId::Session.title());
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("open the Session menu");
		session.keystroke("right").expect("walk one menu along");
		let open = session
			.update(|view, _window, _cx| view.state().menu.open)
			.expect("read the bar");
		assert_eq!(open, Some(MenuSectionId::View), "right moves to the next menu along the bar");

		session.keystroke("left").expect("walk back");
		let open = session
			.update(|view, _window, _cx| view.state().menu.open)
			.expect("read the bar");
		assert_eq!(open, Some(MenuSectionId::Session), "left moves back");
	});
}

#[test]
fn pressing_an_offered_entry_runs_it_and_closes_the_bar() {
	render_session(&[], |session| {
		let captured = session.frame().expect("frame renders");
		let at = drawn_once(&captured, MenuSectionId::View.title());
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("open the View menu");
		let captured = session.frame().expect("the open menu renders");
		let row = drawn_once(&captured, Command::TogglePanel.label());
		session
			.click(Point { x: px(row.x), y: px(row.y) })
			.expect("press the panel toggle");
		let (open, panel_collapsed) = session
			.update(|view, _window, _cx| (view.state().menu.open, view.state().keymap.panel_collapsed))
			.expect("read the window");
		assert!(!panel_collapsed, "pressing the panel toggle opened the panel");
		assert_eq!(open, None, "running an entry closes the bar");
	});
}

#[test]
fn a_press_outside_the_open_menu_closes_the_bar_and_nothing_else() {
	render_session(&[], |session| {
		let captured = session.frame().expect("frame renders");
		let at = drawn_once(&captured, MenuSectionId::View.title());
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("open the View menu");
		let before = session
			.update(|view, _window, _cx| {
				(view.state().keymap.queue_collapsed, view.state().keymap.panel_collapsed)
			})
			.expect("read the window");
		// Far from the card and from the bar: the transcript's lower right, at
		// the 1440x900 window this suite draws.
		session
			.click(Point { x: px(1360.0), y: px(700.0) })
			.expect("press the surface under the open menu");
		let (open, after) = session
			.update(|view, _window, _cx| {
				(
					view.state().menu.open,
					(view.state().keymap.queue_collapsed, view.state().keymap.panel_collapsed),
				)
			})
			.expect("read the window");
		assert_eq!(open, None, "a press outside the card closes the bar");
		assert_eq!(
			after, before,
			"the dismissing press is spent on the dismissal: it does not also reach the control it \
			 landed on"
		);
	});
}

#[test]
fn the_open_menu_takes_the_bare_keys_the_region_underneath_is_bound_to() {
	// A bare `down` is the queue's selection and a bare `enter` is the
	// composer's send. Both are keymap bindings, which are resolved before a
	// keystroke listener runs, so a bar that read its keys without holding the
	// focus would walk nothing and send the draft.
	render_session(&[], |session| {
		session
			.type_text("a draft nobody asked to send")
			.expect("the first frame focused the composer");
		let typed = session
			.update(|view, _window, _cx| view.composer_text().to_owned())
			.expect("read the draft");
		assert!(!typed.trim().is_empty(), "the draft reached the composer: {typed:?}");

		let captured = session.frame().expect("frame renders");
		let at = drawn_once(&captured, MenuSectionId::View.title());
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("open the View menu");
		session.keystroke("down").expect("walk one entry down");
		let walked = session
			.update(|view, _window, _cx| view.state().menu.highlighted_command())
			.expect("read the walk");
		assert_eq!(
			walked,
			Some(Command::TogglePanel),
			"the open menu answers the arrow the queue is bound to"
		);

		session.keystroke("enter").expect("take the entry");
		let (panel_collapsed, raised, draft) = session
			.update(|view, _window, _cx| {
				(
					view.state().keymap.panel_collapsed,
					view.drain_intents(),
					view.composer_text().to_owned(),
				)
			})
			.expect("read the window");
		assert!(!panel_collapsed, "Return took the entry the walk was on");
		assert!(
			!raised.iter().any(|intent| matches!(
				intent,
				Intent::Send { .. } | Intent::Steer(_) | Intent::Queue(_)
			)),
			"Return reached the menu, not the composer's send: {raised:?}"
		);
		assert_eq!(draft, typed, "the draft is still where the operator left it");
	});
}

#[test]
fn the_menu_key_opens_the_bar_and_the_bar_answers_the_keys_after_it() {
	// A bar reached only with a pointer is out of reach of the operator who
	// drives the window from the keyboard, so the menu key opens the first
	// section and the keyboard follows it in.
	render_session(&[], |session| {
		session
			.type_text("a draft nobody asked to send")
			.expect("the first frame focused the composer");
		session.keystroke("f10").expect("the menu key is bound");
		let opened = session
			.update(|view, _window, _cx| view.state().menu.open)
			.expect("read which menu is down");
		assert_eq!(
			opened,
			Some(MenuSectionId::Veyyon),
			"the menu key opens the first section of the bar"
		);

		session.keystroke("right").expect("walk along the bar");
		session.keystroke("down").expect("walk one entry down");
		let walked = session
			.update(|view, _window, _cx| {
				(view.state().menu.open, view.state().menu.highlighted_command())
			})
			.expect("read the walk");
		assert_eq!(
			walked,
			(Some(MenuSectionId::Session), Some(Command::OpenSelectedSession)),
			"the keys after the menu key reach the bar rather than the region under it"
		);

		session.keystroke("escape").expect("leave the bar");
		let after = session
			.update(|view, _window, _cx| (view.state().menu.open, view.composer_text().to_owned()))
			.expect("read the window");
		assert_eq!(after.0, None, "Escape closed the bar the menu key opened");
		assert_eq!(
			after.1, "a draft nobody asked to send",
			"the draft is still where the operator left it"
		);

		// The bar took the keyboard to answer the arrows, so closing it has to
		// give it back: a draft that survived the walk is worth nothing if the
		// next word typed reaches nothing.
		session
			.type_text(" and one more word")
			.expect("type after the bar closed");
		let typed = session
			.update(|view, _window, _cx| view.composer_text().to_owned())
			.expect("read the draft");
		assert_eq!(
			typed, "a draft nobody asked to send and one more word",
			"the composer has the keyboard back, so what is typed after the bar closes reaches the \
			 draft"
		);
	});
}
