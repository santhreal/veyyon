//! One option of a question or a dialog, drawn as the control that answers
//! with it, and the height a card's body scrolls past.

use gpui::{AnyElement, App, ClickEvent, ElementId, Pixels, SharedString, Window, div, prelude::*};
use veyyon_desktop_ui::{
	controls::hover_transition,
	icons::{Icon, IconName},
	theme::{ActiveTheme, Palette, TypeStyled, radius, size, space, text},
};

/// The share of the thread's height a card's body grows to before it
/// scrolls.
const BODY_SHARE: f32 = 0.3;

/// The height a card's body scrolls past: a share of the thread.
pub(super) fn body_max(window: &Window) -> Pixels {
	(window.viewport_size().height - size::HEADER) * BODY_SHARE
}

/// How an option shows whether it is picked: a radio on a question that
/// takes one, a box on one that takes several.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Marker {
	Radio(bool),
	Check(bool),
}

/// One option row.
pub(super) struct OptionRow {
	id:          ElementId,
	index:       usize,
	label:       SharedString,
	description: Option<SharedString>,
	marker:      Option<Marker>,
	recommended: bool,
	cursor:      bool,
	disabled:    bool,
}

impl OptionRow {
	/// The row of option `index`, reading `label`. 1–9 pick the first nine,
	/// so their digit leads the row.
	pub(super) fn new(
		id: impl Into<ElementId>,
		index: usize,
		label: impl Into<SharedString>,
	) -> Self {
		Self {
			id: id.into(),
			index,
			label: label.into(),
			description: None,
			marker: None,
			recommended: false,
			cursor: false,
			disabled: false,
		}
	}

	/// States `description` under the label.
	pub(super) fn description(mut self, description: Option<&String>) -> Self {
		self.description = description.map(|text| text.clone().into());
		self
	}

	/// Shows whether the option is picked.
	pub(super) const fn marker(mut self, marker: Marker) -> Self {
		self.marker = Some(marker);
		self
	}

	/// Marks the option the asker recommends.
	pub(super) const fn recommended(mut self, recommended: bool) -> Self {
		self.recommended = recommended;
		self
	}

	/// Draws the row as the one the keyboard is on.
	pub(super) const fn cursor(mut self, cursor: bool) -> Self {
		self.cursor = cursor;
		self
	}

	/// Draws the row as one nothing can answer with now.
	pub(super) const fn disabled(mut self, disabled: bool) -> Self {
		self.disabled = disabled;
		self
	}

	/// The row, calling `on_click` when an enabled row is clicked.
	pub(super) fn render(
		self,
		on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
		cx: &App,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let hover = palette.bg.hover;
		let digit = (self.index < 9).then(|| (self.index + 1).to_string());
		let label_color = if self.disabled {
			palette.text.faint
		} else {
			palette.text.primary
		};
		let label = div()
			.flex()
			.items_center()
			.gap(space::S2)
			.child(
				div()
					.min_w_0()
					.type_style(text::UI)
					.text_color(label_color)
					.child(self.label),
			)
			.when(self.recommended, |line| {
				line.child(
					div()
						.flex_none()
						.type_style(text::MICRO)
						.text_color(palette.accent.base)
						.child("Recommended"),
				)
			});
		div()
			.id(self.id)
			.flex()
			.items_start()
			.gap(space::S2)
			.px(space::S2)
			.py(space::S1_5)
			.rounded(radius::MD)
			.transition(hover_transition())
			.when(self.cursor, |row| row.bg(hover))
			.when(!self.disabled, |row| {
				row.cursor_pointer()
					.hover(move |style| style.bg(hover))
					.on_click(on_click)
			})
			.child(
				div()
					.flex_none()
					.w(size::ICON)
					.type_style(text::SMALL)
					.text_color(palette.text.faint)
					.children(digit),
			)
			.children(self.marker.map(|marker| mark(marker, &palette)))
			.child(
				div()
					.flex()
					.flex_col()
					.flex_1()
					.min_w_0()
					.child(label)
					.children(self.description.map(|description| {
						div()
							.type_style(text::SMALL)
							.text_color(palette.text.muted)
							.child(description)
					})),
			)
			.into_any_element()
	}
}

/// A radio or a box, filled in the accent while picked.
fn mark(marker: Marker, palette: &Palette) -> impl IntoElement {
	let (multi, picked) = match marker {
		Marker::Radio(picked) => (false, picked),
		Marker::Check(picked) => (true, picked),
	};
	let shape = div()
		.flex_none()
		.mt(space::S0_5)
		.size(size::ICON_SM)
		.flex()
		.items_center()
		.justify_center()
		.border_1();
	let shape = if multi {
		shape.rounded(radius::SM)
	} else {
		shape.rounded_full()
	};
	if !picked {
		return shape.border_color(palette.border.strong);
	}
	let inner = if multi {
		Icon::new(IconName::Check)
			.size(size::ICON_SM)
			.color(palette.accent.fg)
			.into_any_element()
	} else {
		div()
			.size(size::DOT)
			.rounded_full()
			.bg(palette.accent.fg)
			.into_any_element()
	};
	shape
		.border_color(palette.accent.base)
		.bg(palette.accent.base)
		.child(inner)
}
