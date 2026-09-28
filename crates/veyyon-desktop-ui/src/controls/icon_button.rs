//! A square button that shows one icon and names its action in a tooltip.

use veyyon_gpui::{
	App, ClickEvent, CursorStyle, ElementId, IntoElement, RenderOnce, SharedString, Window, div,
	prelude::*,
};

use super::{Kbd, Tooltip, hover_transition};
use crate::{
	icons::{Icon, IconName},
	theme::{ActiveTheme, radius, size},
};

type ClickHandler = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// A [`size::CONTROL`] square button with one [`size::ICON`] glyph.
///
/// The glyph draws in the muted text color, and in the primary text color
/// while hovered or selected. A selected button keeps the selected fill.
#[derive(IntoElement)]
pub struct IconButton {
	id:       ElementId,
	icon:     IconName,
	tooltip:  Option<SharedString>,
	shortcut: Option<Kbd>,
	selected: bool,
	disabled: bool,
	on_click: Option<ClickHandler>,
}

impl IconButton {
	/// A button showing `icon`. `id` keys the button's press and tooltip state,
	/// so it is unique among its siblings.
	pub fn new(id: impl Into<ElementId>, icon: IconName) -> Self {
		Self {
			id: id.into(),
			icon,
			tooltip: None,
			shortcut: None,
			selected: false,
			disabled: false,
			on_click: None,
		}
	}

	/// Shows `text` in a tooltip while the button is hovered.
	pub fn tooltip(mut self, text: impl Into<SharedString>) -> Self {
		self.tooltip = Some(text.into());
		self
	}

	/// Shows `shortcut` after the tooltip text.
	pub fn shortcut(mut self, shortcut: Kbd) -> Self {
		self.shortcut = Some(shortcut);
		self
	}

	/// Draws the button in its selected state.
	pub const fn selected(mut self, selected: bool) -> Self {
		self.selected = selected;
		self
	}

	/// Disables the button.
	pub const fn disabled(mut self, disabled: bool) -> Self {
		self.disabled = disabled;
		self
	}

	/// Calls `handler` when an enabled button is clicked.
	pub fn on_click(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_click = Some(Box::new(handler));
		self
	}
}

impl RenderOnce for IconButton {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let palette = cx.theme().palette;
		let color = if self.disabled {
			palette.text.faint
		} else if self.selected {
			palette.text.primary
		} else {
			palette.text.muted
		};
		let shortcut = self.shortcut;
		let tooltip = self.tooltip.map(|text| Tooltip::builder(text, shortcut));
		div()
			.id(self.id)
			.flex()
			.flex_none()
			.items_center()
			.justify_center()
			.size(size::CONTROL)
			.rounded(radius::MD)
			.text_color(color)
			.transition(hover_transition())
			.when(self.selected, |button| button.bg(palette.bg.selected))
			.when(self.disabled, |button| button.cursor(CursorStyle::OperationNotAllowed))
			.when(!self.disabled, |button| {
				button
					.cursor(CursorStyle::PointingHand)
					.hover(move |style| style.bg(palette.bg.hover).text_color(palette.text.primary))
					.active(move |style| style.bg(palette.bg.selected))
			})
			.when_some(self.on_click.filter(|_| !self.disabled), |button, handler| {
				button.on_click(move |event, window, cx| handler(event, window, cx))
			})
			.when_some(tooltip, |button, tooltip| button.tooltip(tooltip))
			.child(Icon::new(self.icon))
	}
}
