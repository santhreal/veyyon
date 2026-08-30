//! A setting: what it is called, what it does, and the control that changes it.
//!
//! Every row on every settings page is a [`Field`], and every heading over a
//! run of them is a [`Group`]. That is the whole of the settings layout, so a
//! page adds rows rather than a layout, and a new page looks like the others
//! without having to be told to.
//!
//! THE DESCRIPTION IS NOT OPTIONAL PROSE. A setting whose name does not say
//! what it does needs one line that does, in terms of what changes on screen. A
//! description that repeats the name is worse than none, because it costs a
//! line and answers nothing.

use gpui::{
	AnyElement, App, IntoElement, ParentElement, RenderOnce, SharedString, Styled, Window, div, px,
};

use super::text;
use crate::theme::{Theme, layout, radius, size, space, weight};

/// One setting.
#[derive(IntoElement)]
pub struct Field {
	what:    SharedString,
	note:    Option<SharedString>,
	/// The control at the far end: a switch, a select, a stepper.
	control: Vec<AnyElement>,
	/// A control wide enough to need the row to itself, below the label: a
	/// theme editor, a path input.
	below:   bool,
}

impl Field {
	pub fn new(what: impl Into<SharedString>) -> Field {
		Field { what: what.into(), note: None, control: Vec::new(), below: false }
	}

	/// What the setting does, in terms of what changes on screen.
	pub fn note(mut self, note: impl Into<SharedString>) -> Field {
		self.note = Some(note.into());
		self
	}

	/// Put the control under the label rather than at the far end.
	pub fn stacked(mut self) -> Field {
		self.below = true;
		self
	}
}

impl ParentElement for Field {
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.control.extend(elements);
	}
}

impl RenderOnce for Field {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);

		// The words shrink; the control does not. A flex item's automatic
		// minimum is its own content, so without a floor of zero the note keeps
		// the row wider than the card and pushes the control out through the
		// right edge of the window.
		let label = text::stack(space::PAIR)
			.flex_1()
			.min_w(px(0.0))
			.overflow_hidden()
			.child(
				text::line(self.what)
					.text_size(px(size::BODY))
					.font_weight(weight::MEDIUM)
					.line_height(px(size::BODY * size::LINE_TIGHT))
					.text_color(theme.text),
			)
			.children(
				self
					.note
					.map(|note| text::note_wrapping(note, &theme).max_w(px(layout::MEASURE))),
			);

		let row = div()
			.flex()
			.w_full()
			.py(px(space::BASE))
			.px(px(space::WIDE));
		if self.below {
			row.flex_col()
				.gap(px(space::SNUG))
				.child(label)
				.child(div().flex().w_full().children(self.control))
		} else {
			row.items_center().gap(px(space::WIDE)).child(label).child(
				div()
					.flex()
					.flex_none()
					.items_center()
					.gap(px(space::SNUG))
					.children(self.control),
			)
		}
	}
}

/// A run of settings under one heading.
///
/// The rows inside share a ground, with a hairline between them that stops
/// short of the edge. Space alone does not separate two rows that already sit
/// on the same fill: the eye reads the fill as the unit and the rows run
/// together, which is the difference between two settings and one setting with
/// four lines.
#[derive(IntoElement)]
pub struct Group {
	what:   SharedString,
	note:   Option<SharedString>,
	fields: Vec<AnyElement>,
}

impl Group {
	pub fn new(what: impl Into<SharedString>) -> Group {
		Group { what: what.into(), note: None, fields: Vec::new() }
	}

	/// What the whole group is for, when the heading alone does not say.
	pub fn note(mut self, note: impl Into<SharedString>) -> Group {
		self.note = Some(note.into());
		self
	}
}

impl ParentElement for Group {
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.fields.extend(elements);
	}
}

impl RenderOnce for Group {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		text::stack(space::SNUG)
			.w_full()
			.child(
				text::stack(space::PAIR)
					.px(px(space::WIDE))
					.child(
						text::line(self.what)
							.text_size(px(size::LEAD))
							.font_weight(weight::MEDIUM)
							.line_height(px(size::LEAD * size::LINE_TIGHT))
							.text_color(theme.text),
					)
					.children(
						self
							.note
							.map(|note| text::note_wrapping(note, &theme).max_w(px(layout::MEASURE))),
					),
			)
			.child(
				divided(self.fields, &theme)
					.w_full()
					.rounded(px(radius::CARD))
					.bg(theme.raised),
			)
	}
}

/// The rows, with a line between each pair and none at either end.
fn divided(fields: Vec<AnyElement>, theme: &Theme) -> gpui::Div {
	let mut stack = text::stack(0.0);
	let last = fields.len().saturating_sub(1);
	for (index, field) in fields.into_iter().enumerate() {
		stack = stack.child(field);
		if index != last {
			stack = stack.child(div().px(px(space::WIDE)).child(text::hairline(theme)));
		}
	}
	stack
}
