//! Captured text, source, and an argument that did not parse.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::view::{Code, Invalid, Output, OutputVariant, Tone};
use veyyon_gui_kit::{
	Level,
	chrome::{column, row},
	surface,
	text::{caption, mono, text_in},
	theme::ActiveTheme,
	tokens::{radius, space, text},
};
use veyyon_gui_theme::Role;

use crate::tone;

pub fn output(value: &Output, cx: &App) -> Div {
	let (lines, hidden) = value.visible();
	let role = body_role(value.variant);
	let block = surface(Level::Sunken, cx)
		.w_full()
		.p(space::SNUG)
		.rounded(radius::SMALL)
		.flex()
		.flex_col()
		.children(
			lines
				.into_iter()
				.map(|line| mono(line.to_owned(), role, cx)),
		);
	let block = match fill_role(value.variant) {
		None => block,
		Some(role) => block.bg(veyyon_gui_kit::chrome::wash(cx.color(role))),
	};

	let mut stack = column(space::TIGHT);
	if let Some(title) = &value.title {
		stack = stack.child(caption(title.clone(), cx));
	}
	stack = stack.child(block);
	if hidden > 0 {
		stack = stack.child(caption(more_line(hidden), cx));
	}
	stack
}

/// The line that reports what is not shown.
///
/// The count comes from `Output::visible`, which adds the lines the producer
/// already dropped to the ones this cap hides. A renderer that subtracted only
/// its own cap would under-report every tool that truncates upstream.
pub fn more_line(hidden: usize) -> String {
	if hidden == 1 {
		"1 more line".to_owned()
	} else {
		format!("{hidden} more lines")
	}
}

/// The role captured text reads in.
pub fn body_role(variant: OutputVariant) -> Role {
	match variant {
		OutputVariant::Plain => Role::ToolOutput,
		OutputVariant::Error => Role::StateError,
		OutputVariant::Muted => Role::TextMuted,
	}
}

/// The role a block's ground is tinted from, or `None` to keep the level's own.
///
/// Only a failure is tinted. Every variant sits in a well, so the tint is what
/// separates standard error from standard output rather than the depth.
pub fn fill_role(variant: OutputVariant) -> Option<Role> {
	match variant {
		OutputVariant::Error => Some(Role::ToolErrorBg),
		OutputVariant::Plain | OutputVariant::Muted => None,
	}
}

pub fn code(value: &Code, cx: &App) -> Div {
	let width = gutter_width(value, cx);
	let rows = value.text.lines().enumerate().map(|(offset, line)| {
		let mut line_row = row(space::SNUG);
		if let Some(first) = value.first_line {
			let number = first + offset;
			line_row = line_row.child(mono(number.to_string(), Role::TextMuted, cx).min_w(width));
		}
		line_row.child(mono(line.to_owned(), Role::MdCodeBlock, cx))
	});

	let block = surface(Level::Sunken, cx)
		.w_full()
		.p(space::SNUG)
		.rounded(radius::SMALL)
		.border_1()
		.border_color(cx.color(Role::MdCodeBlockBorder))
		.flex()
		.flex_col()
		.children(rows);

	let mut stack = column(space::TIGHT);
	if let Some(title) = &value.title {
		stack = stack.child(caption(title.clone(), cx));
	}
	stack.child(block)
}

/// The width the line-number gutter reserves.
///
/// Sized from the largest number the block draws, so a block starting at line
/// 998 does not shift by a character partway down.
fn gutter_width(value: &Code, cx: &App) -> gpui::Pixels {
	let _ = cx;
	let last = value.first_line.unwrap_or(1) + value.text.lines().count();
	gpui::px(f32::from(digits(last)) * 8.0)
}

/// How many characters the largest line number occupies.
pub fn digits(value: usize) -> u8 {
	let mut count = 1u8;
	let mut value = value / 10;
	while value > 0 {
		count = count.saturating_add(1);
		value /= 10;
	}
	count
}

pub fn invalid(value: &Invalid, cx: &App) -> Div {
	let mut stack = column(space::TIGHT).child(row(space::SNUG).child(text_in(
		heading(value),
		tone::role(Some(Tone::Err)),
		text::BODY,
		cx,
	)));
	stack = stack.child(mono(value.received.clone(), Role::TextPrimary, cx));
	if let Some(expected) = &value.expected {
		stack = stack.child(caption(format!("expected {expected}"), cx));
	}
	stack
}

/// What the failure says, with the argument's name when there is one.
///
/// A whole payload that did not parse has no name, and "the argument did not
/// parse" without saying which one is the message this avoids.
pub fn heading(value: &Invalid) -> String {
	match &value.name {
		Some(name) => format!("{name} did not parse"),
		None => "the arguments did not parse".to_owned(),
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! Two numbers a reader trusts and cannot check: the "N more lines" count,
	//! and the line numbers in a code gutter. The first is wrong whenever a
	//! renderer subtracts its own cap instead of asking the payload, which
	//! under- reports every tool that truncates upstream and looks correct. The
	//! second shifts the whole block by a character when the gutter is sized
	//! from the first number rather than the last.
	//!
	//! WHAT IT DOES NOT CATCH. Wrapping, and syntax highlighting, which is not
	//! wired: the language tag is carried for whichever host draws it.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn the_more_line_reports_what_the_payload_says_not_the_cap() {
		let fixture = fixtures::views::output();
		let (_, hidden) = fixture.visible();
		assert_eq!(hidden, 14, "the fixture caps 2 and the producer dropped 12");
		assert_eq!(more_line(hidden), "14 more lines");
	}

	#[test]
	fn one_hidden_line_is_singular() {
		assert_eq!(more_line(1), "1 more line");
		assert_eq!(more_line(2), "2 more lines");
	}

	#[test]
	fn a_failure_never_reads_in_the_ordinary_output_role() {
		assert_eq!(body_role(OutputVariant::Error), Role::StateError);
		assert_ne!(body_role(OutputVariant::Error), body_role(OutputVariant::Plain));
		assert_ne!(body_role(OutputVariant::Muted), body_role(OutputVariant::Plain));
	}

	#[test]
	fn the_gutter_is_sized_by_the_largest_number_it_draws() {
		assert_eq!(digits(1), 1);
		assert_eq!(digits(9), 1);
		assert_eq!(digits(10), 2);
		assert_eq!(digits(998), 3);
		assert_eq!(digits(1_000), 4);
	}

	#[test]
	fn an_unnamed_failure_still_says_what_failed() {
		let named = fixtures::views::invalid();
		assert_eq!(heading(&named), "mode did not parse");
		assert_eq!(heading(&Invalid::new("{")), "the arguments did not parse");
	}
}
