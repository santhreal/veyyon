//! A full-window statement with key hints.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::screen::{KeyHint, Splash};
use veyyon_gui_kit::{
	chrome::{chip, column, row},
	text::{body, caption, title},
	tokens::{space, text},
};
use veyyon_gui_theme::Role;

pub fn splash(value: &Splash, cx: &App) -> Div {
	let mut stack = column(space::BASE)
		.child(title(value.headline.clone(), cx))
		.children(value.lines.iter().map(|line| body(line.clone(), cx)));

	if !value.keys.is_empty() {
		stack = stack.child(
			row(space::WIDE)
				.flex_wrap()
				.children(value.keys.iter().map(|hint| self::hint(hint, cx))),
		);
	}
	if let Some(footer) = &value.footer {
		stack = stack.child(caption(footer.clone(), cx));
	}

	gpui::div()
		.size_full()
		.flex()
		.flex_col()
		.items_center()
		.justify_center()
		.p(space::WIDE)
		.child(stack.items_center())
}

/// One key hint: the keys, then what they do.
fn hint(value: &KeyHint, cx: &App) -> Div {
	row(space::SNUG)
		.items_baseline()
		.child(chip(value.keys.clone(), Role::TextAccent, cx))
		.child(veyyon_gui_kit::text::text_in(
			value.action.clone(),
			Role::TextSecondary,
			text::SMALL,
			cx,
		))
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A splash with no hints is a window an operator cannot leave: it is the
	//! only screen with no other affordance on it, so a hint list that is empty
	//! or that omits the key that dismisses it is a dead end rather than a
	//! cosmetic gap.
	//!
	//! WHAT IT DOES NOT CATCH. Whether a key does what its hint says. Nothing is
	//! bound yet.

	use veyyon_gui_contract::fixtures;

	#[test]
	fn the_welcome_splash_says_how_to_leave_it() {
		let welcome = fixtures::routes::welcome();
		assert!(!welcome.keys.is_empty(), "a splash with no hints is a dead end");
		assert!(
			welcome.keys.iter().any(|hint| hint.keys.contains("ctrl-c")),
			"no hint says how to quit"
		);
	}

	#[test]
	fn no_two_hints_claim_the_same_keys() {
		let welcome = fixtures::routes::welcome();
		let mut keys: Vec<&str> = welcome.keys.iter().map(|hint| hint.keys.as_str()).collect();
		let count = keys.len();
		keys.sort_unstable();
		keys.dedup();
		assert_eq!(keys.len(), count, "two hints claim the same keys");
	}

	#[test]
	fn every_hint_says_what_its_keys_do() {
		for hint in fixtures::routes::welcome().keys {
			assert!(!hint.action.is_empty(), "{} has no action", hint.keys);
			assert!(!hint.keys.is_empty(), "an action has no keys: {}", hint.action);
		}
	}
}
