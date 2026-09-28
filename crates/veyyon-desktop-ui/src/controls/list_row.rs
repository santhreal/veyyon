//! A clickable row of a list: leading slot, label, trailing slot.

use veyyon_gpui::{
	AnyElement, App, ClickEvent, CursorStyle, ElementId, IntoElement, RenderOnce, SharedString,
	Window, div, prelude::*,
};

use super::hover_transition;
use crate::theme::{ActiveTheme, TypeStyled, radius, size, space, text};

type ClickHandler = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// A [`size::ROW`] row with a leading slot, a label that truncates, and a
/// trailing slot.
///
/// The row fills with `bg.hover` while hovered and with `bg.selected` while
/// selected; a selected row draws its label in the primary text color.
#[derive(IntoElement)]
pub struct ListRow {
	id:       ElementId,
	label:    SharedString,
	leading:  Option<AnyElement>,
	trailing: Option<AnyElement>,
	selected: bool,
	on_click: Option<ClickHandler>,
}

impl ListRow {
	/// A row showing `label`. `id` keys the row's press state, so it is unique
	/// among its siblings.
	pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
		Self {
			id:       id.into(),
			label:    label.into(),
			leading:  None,
			trailing: None,
			selected: false,
			on_click: None,
		}
	}

	/// Draws `element` before the label.
	pub fn leading(mut self, element: impl IntoElement) -> Self {
		self.leading = Some(element.into_any_element());
		self
	}

	/// Draws `element` at the end of the row.
	pub fn trailing(mut self, element: impl IntoElement) -> Self {
		self.trailing = Some(element.into_any_element());
		self
	}

	/// Draws the row in its selected state.
	pub const fn selected(mut self, selected: bool) -> Self {
		self.selected = selected;
		self
	}

	/// Calls `handler` when the row is clicked.
	pub fn on_click(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_click = Some(Box::new(handler));
		self
	}
}

impl RenderOnce for ListRow {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let palette = cx.theme().palette;
		div()
			.id(self.id)
			.flex()
			.items_center()
			.gap(space::S2)
			.h(size::ROW)
			.px(space::S2)
			.rounded(radius::MD)
			.type_style(text::UI)
			.transition(hover_transition())
			.when(self.selected, |row| row.bg(palette.bg.selected).text_color(palette.text.primary))
			.when(!self.selected, |row| {
				row.text_color(palette.text.secondary)
					.hover(move |style| style.bg(palette.bg.hover).text_color(palette.text.primary))
			})
			.when_some(self.on_click, |row, handler| {
				row.cursor(CursorStyle::PointingHand)
					.on_click(move |event, window, cx| handler(event, window, cx))
			})
			.children(self.leading)
			.child(div().flex_1().min_w_0().truncate().child(self.label))
			.children(self.trailing)
	}
}
