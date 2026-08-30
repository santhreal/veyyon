//! Named values, drawn as a two-column grid.

use std::sync::LazyLock;

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::view::{Fields, Pair};
use veyyon_gui_kit::{
	chrome::{chip, column, row},
	text::{mono, text_in},
	tokens::{space, text},
};
use veyyon_gui_theme::Role;

use crate::{path, tone};

/// How many path segments a value keeps before the middle is elided.
///
/// A grid value shares its line with a name, so it has less room than a
/// heading.
const PATH_BUDGET: usize = 4;

pub fn fields(value: &Fields, cx: &App) -> Div {
	column(space::TIGHT).children(value.pairs.iter().map(|pair| field(pair, cx)))
}

/// One pair: the name set back, the value in the reading colour or its tone.
fn field(pair: &Pair, cx: &App) -> Div {
	let name = text_in(pair.name.clone(), name_role(), text::SMALL, cx).min_w(NAME_WIDTH);
	let role = tone::role(pair.tone);
	let shown = display_value(pair, home());
	let value = if pair.is_path {
		mono(shown, role, cx)
	} else {
		text_in(shown, role, text::BODY, cx)
	};

	row(space::SNUG)
		.items_start()
		.child(name)
		.child(value)
		.children(
			pair
				.badges
				.iter()
				.map(|badge| chip(badge.text.clone(), tone::role(badge.tone), cx)),
		)
}

/// The width the names align to, so the values start on one column.
const NAME_WIDTH: gpui::Pixels = gpui::px(112.0);

/// The value as it is drawn: a path shortened, anything else as it arrived.
///
/// Separate from [`field`] so the rule is asserted without a window. A path
/// drawn whole is how an operator's home directory reaches a screenshot.
pub fn display_value(pair: &Pair, home: Option<&str>) -> String {
	if pair.is_path {
		path::shorten(&pair.value, home, PATH_BUDGET)
	} else {
		pair.value.clone()
	}
}

/// The home directory paths are drawn relative to.
///
/// Resolved once. A session that outlived an environment change would draw the
/// old home, which costs a stale `~` and not a wrong path: the value drawn is
/// still the value the tool reported.
pub fn home() -> Option<&'static str> {
	static HOME: LazyLock<Option<String>> = LazyLock::new(|| std::env::var("HOME").ok());
	HOME.as_deref()
}

/// The role a name is drawn in. Named so no caller re-decides it.
pub fn name_role() -> Role {
	Role::TextSecondary
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A path pair is the one value in this kind that must not be drawn as it
	//! arrived: the contract carries the whole path so it can be opened, and
	//! drawing it whole puts an operator's home directory into every screenshot.
	//! The rule is one branch, and a branch that reads `is_path` the wrong way
	//! round still draws something plausible.
	//!
	//! WHAT IT DOES NOT CATCH. Alignment. Whether the values line up is the
	//! window's own measurement.

	use veyyon_gui_contract::view::Tone;

	use super::*;

	#[test]
	fn a_path_value_is_shortened_and_a_plain_value_is_not() {
		let path = Pair::path("path", "/home/dev/veyyon/hosts/gui/views/src/lib.rs");
		assert_eq!(display_value(&path, Some("/home/dev")), "~/…/views/src/lib.rs");

		let plain = Pair::new("command", "/home/dev/veyyon/run.sh");
		assert_eq!(display_value(&plain, Some("/home/dev")), "/home/dev/veyyon/run.sh");
	}

	#[test]
	fn the_fixture_pairs_carry_a_path_and_a_verdict_to_draw() {
		let fixture = veyyon_gui_contract::fixtures::views::fields();
		assert!(fixture.pairs.iter().any(|pair| pair.is_path));
		assert!(fixture.pairs.iter().any(|pair| pair.tone == Some(Tone::Ok)));
	}

	#[test]
	fn a_name_never_reads_in_the_value_colour() {
		assert_ne!(name_role(), tone::role(None));
	}
}
