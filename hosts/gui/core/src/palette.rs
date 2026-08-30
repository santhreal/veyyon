//! The one list a reader searches, and what taking a row does.
//!
//! Two kinds of row in one list: the conversations, and the commands. Both are
//! reached by typing part of what they are called, because a reader who wants a
//! conversation and a reader who wants a command both start by typing.
//!
//! FILTERING LIVES HERE, NOT IN THE VIEW. The cursor, the accept and the drawn
//! list read one function, so a row cannot be highlighted at an index the view
//! does not draw. That defect is invisible until somebody presses Return.
//!
//! A command matches on what it is called and on its keywords, never on an
//! internal name: a list that answers "app" with a line about light and dark
//! reads as a wrong answer.

use crate::{
	command::Command,
	store::model::{Overlay, Palette, Store},
};

/// Which corpus a row came from.
///
/// The list is drawn as one run of each, under a heading, so the word saying
/// which kind a row is belongs to the run rather than to every row in it: the
/// same word printed twelve times down one column is noise a reader has to
/// look past to find the one thing they came for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
	Conversation,
	Command,
}

/// One row of the palette: what it says, and what taking it does.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
	pub kind:    Kind,
	pub label:   String,
	/// The right-hand column: the checkout a conversation is in, and nothing at
	/// all for a command, whose chord goes there instead.
	pub detail:  String,
	/// Whether this row is what is already on screen.
	pub current: bool,
	pub command: Command,
}

/// Open the palette over whatever is on screen.
pub fn open(store: &mut Store) {
	store.overlay = Overlay::Palette(Palette { query: String::new(), selected: 0 });
}

/// Close whatever floats over the window.
pub fn close(store: &mut Store) {
	store.overlay = Overlay::None;
}

/// Type into the palette, which puts the cursor back on the first match.
pub fn query(store: &mut Store, query: String) {
	if let Overlay::Palette(palette) = &mut store.overlay {
		palette.query = query;
		palette.selected = 0;
	}
}

/// Move the cursor, clamped to the matches rather than wrapping: a list that
/// wraps under a held key never settles at either end.
pub fn move_cursor(store: &mut Store, delta: isize) {
	let count = rows(store).len();
	if count == 0 {
		return;
	}
	if let Overlay::Palette(palette) = &mut store.overlay {
		let at = palette.selected as isize + delta;
		palette.selected = at.clamp(0, count as isize - 1) as usize;
	}
}

/// Take the highlighted row: close the palette, and hand back the command it
/// carried so the caller can run it and carry out its outcome.
///
/// The palette closes first. A command that opens a settings page, or quits,
/// leaves a palette behind it otherwise.
pub fn accept(store: &mut Store) -> Option<Command> {
	let rows = rows(store);
	let palette = store.overlay.palette()?;
	let command = rows.get(palette.selected)?.command.clone();
	store.overlay = Overlay::None;
	Some(command)
}

/// The rows for the current query, in the order they are drawn.
///
/// Conversations first: the palette is opened to switch conversations far more
/// often than to run a command, and a list that puts commands first makes the
/// common case scroll.
pub fn rows(store: &Store) -> Vec<Row> {
	let Some(palette) = store.overlay.palette() else {
		return Vec::new();
	};
	let query = palette.query.trim().to_lowercase();
	let matches = |haystack: &str| query.is_empty() || haystack.to_lowercase().contains(&query);

	// The checkout a conversation belongs to is worth a column only when there
	// is more than one. One name repeated down the list says nothing and crowds
	// the title beside it.
	let name_checkouts = store.projects.len() > 1;
	let mut rows: Vec<Row> = store
		.sessions
		.iter()
		.filter(|session| matches(&session.title))
		.map(|session| Row {
			kind:    Kind::Conversation,
			label:   session.title.clone(),
			detail:  if name_checkouts {
				store
					.project(&session.project)
					.map(|project| project.name.clone())
					.unwrap_or_default()
			} else {
				String::new()
			},
			current: store.selected.as_ref() == Some(&session.id),
			command: Command::SelectSession(session.id.clone()),
		})
		.collect();

	rows.extend(
		crate::command::searchable()
			.into_iter()
			.filter(|command| command.applies(store))
			.filter(|command| matches(command.what()) || matches(command.keywords()))
			.map(|command| Row {
				kind: Kind::Command,
				label: command.what().to_owned(),
				detail: String::new(),
				current: false,
				command,
			}),
	);
	rows
}

#[cfg(test)]
mod tests;
