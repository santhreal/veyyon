//! WHY THIS SUITE EXISTS.
//!
//! An outcome is what a command asks the window for, and every field of it is a
//! side effect nothing else in the store can perform: closing the window, and
//! putting a list back on the row it just selected. Both have a failure in each
//! direction, and both are silent.
//!
//! A command that moves a selection and does not ask for it to be revealed
//! answers a keystroke with a screen that did not change, because the row it
//! selected is below the twelve the box shows. A command that asks without
//! moving anything drags the list away from wherever the reader had scrolled
//! it, on a keystroke that had nothing to do with the list. Quitting is the
//! same shape with a worse end: asked for where it was not meant, the window
//! closes under the reader.
//!
//! Both sets are swept from the enum and pinned by exact equality, so a command
//! added to the table turns this red until somebody decides which of the two it
//! asks for.
//!
//! WHAT IT DOES NOT CATCH. Whether the window then does it. The field is read
//! by `Shell::perform`, and a reveal carried out on the wrong scroll handle, or
//! a field left unread, passes here: that seam needs a window.

use super::{Command, every_command, two};

#[test]
fn only_quitting_asks_the_window_to_close() {
	let store = two();
	for command in every_command(&store) {
		let mut store = two();
		let asks = command.clone().run(&mut store).quit;
		assert_eq!(asks, command == Command::Quit, "{command:?} disagrees about quitting");
	}
}

#[test]
fn only_a_command_that_moves_a_selection_asks_for_it_to_be_revealed() {
	let store = two();
	let asked: Vec<Command> = every_command(&store)
		.into_iter()
		.filter(|command| {
			let mut store = two();
			command.clone().run(&mut store).reveal_selection
		})
		.collect();

	let session = store
		.sessions
		.first()
		.expect("a store opens with a conversation")
		.id
		.clone();
	assert_eq!(asked, vec![
		Command::NewSession,
		Command::SelectSession(session.clone()),
		Command::DeleteSession(session),
		Command::DeleteSelected,
		Command::CycleSession { forward: true },
		Command::CycleSession { forward: false },
		Command::OpenPalette,
		Command::MovePaletteCursor { down: true },
		Command::MovePaletteCursor { down: false },
		Command::PaletteQuery("new".to_owned()),
	]);
}
