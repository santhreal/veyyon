//! What a palette row carries besides its words.

use veyyon_gui_core::{
	keys,
	palette::{Kind, Row},
};
use veyyon_gui_kit::ui::Icon;

/// What a run of rows of one kind is called.
///
/// Plural, because it heads a run rather than labelling a row, and in the words
/// the rest of the window uses for the same things.
pub fn heading(kind: Kind) -> &'static str {
	match kind {
		Kind::Conversation => "Conversations",
		Kind::Command => "Commands",
	}
}

/// The drawing at the left of a row, where the command has one.
///
/// A conversation has none: its title is what identifies it, and a column of
/// identical marks beside a column of titles says nothing while making the two
/// or three rows that do carry a meaning unfindable.
pub fn mark(row: &Row) -> Option<Icon> {
	crate::glyph::of(&row.command)
}

/// The chord at the right of a row, where the window has one for it.
///
/// Read from the key table rather than stored on the row: a chord printed
/// beside a command is a promise that the keystroke does that thing, and the
/// only way to keep it is to print what is installed.
pub fn chord(row: &Row) -> Option<&'static str> {
	keys::chord_for(&row.command)
}

/// Whether a row is the one already on screen, which is drawn with a mark
/// rather than said in words.
pub fn current(row: &Row) -> bool {
	row.current
}

/// Where the selected row sits among the list's own children.
///
/// The list draws a heading above each run of one kind, and gpui counts a
/// heading as a child like any other, so a row's place among the rows is not
/// its place in the box that scrolls. Out of range collapses to the first
/// child, which is what an empty list and a stale cursor both mean.
pub fn selected_child(rows: &[Row], selected: usize) -> usize {
	let mut kind = None;
	let mut children = 0usize;
	for (index, row) in rows.iter().enumerate() {
		if kind != Some(row.kind) {
			kind = Some(row.kind);
			children += 1;
		}
		if index == selected {
			return children;
		}
		children += 1;
	}
	0
}
