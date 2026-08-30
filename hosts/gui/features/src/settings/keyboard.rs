//! The keyboard page.
//!
//! Built from the one key table, so a chord that works is listed and a chord
//! that is listed works. Nothing is written out here: this file decides how the
//! rows are grouped and what each group is called, and that is all it decides.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::keys::{self, Context, Row};
use veyyon_gui_kit::{
	theme::{Theme, space},
	ui::{Field, Group, kbd},
};

/// What a context is called, for a reader who has never heard the word.
///
/// Exhaustive, so a context added to the table has to be given words before it
/// can be drawn: a group heading left blank is a list of chords nobody can
/// place.
pub fn heading(context: Context) -> &'static str {
	match context {
		Context::Everywhere => "Anywhere",
		Context::Shell => "The window",
		Context::Composer => "Writing a message",
		Context::Palette => "The palette",
	}
}

/// The listed rows, grouped by where they apply, in the order the table has
/// them.
///
/// Order comes from the table rather than from a sort: the table is written in
/// the order a reader learns the chords, and an alphabetical list of shortcuts
/// puts the two nobody uses at the top.
pub fn groups() -> Vec<(&'static str, Vec<Row>)> {
	let mut groups: Vec<(&'static str, Vec<Row>)> = Vec::new();
	for row in keys::listed_rows() {
		let heading = heading(row.context);
		match groups.iter_mut().find(|(name, _)| *name == heading) {
			Some((_, rows)) => rows.push(row),
			None => groups.push((heading, vec![row])),
		}
	}
	groups
}

/// The page.
pub fn render(cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let mut page = div().flex().flex_col().gap(px(space::LOOSE));
	for (heading, rows) in groups() {
		let mut group = Group::new(heading);
		for row in rows {
			// The chord at the right, in keys rather than in the syntax the
			// table is written in: `secondary-k` is a keymap, not something to
			// read.
			group = group.child(Field::new(row.command.what()).child(kbd::caps(row.keys, &theme)));
		}
		page = page.child(group);
	}
	page
}
