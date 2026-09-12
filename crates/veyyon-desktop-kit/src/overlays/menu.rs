//! Context Menu / Dropdown Menu container primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ClickEvent, ElementId, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::{
	Picker, PickerEvent, SelectionState,
	icons::{Icon, IconSize},
	state::{MenuItem, MenuRowTone},
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// Context and dropdown menu popup container.
#[derive(IntoElement)]
pub struct Menu {
	items:     Vec<MenuItem>,
	on_select:
		Option<Arc<dyn Fn(usize, &ClickEvent, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl Menu {
	/// Creates a menu container with items.
	#[must_use]
	pub fn new(items: impl IntoIterator<Item = MenuItem>) -> Self {
		Self { items: items.into_iter().collect(), on_select: None }
	}

	/// Sets item selection callback.
	#[must_use]
	pub fn on_select(
		mut self,
		handler: impl Fn(usize, &ClickEvent, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_select = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for Menu {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let bg = tokens.color(ColorRole::Float);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Md);
		let pad = tokens.spacing(SpacingStep::S1);
		let item_pad_x = tokens.spacing(SpacingStep::S3);
		let item_pad_y = tokens.spacing(SpacingStep::S2);
		let font_size = tokens.font_size(TextRamp::Body);

		let mut container = div()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.p(pad)
			.shadow_lg()
			.flex()
			.flex_col();

		// A menu whose rows carry icons keeps the gutter for the ones that do
		// not, so every label starts on the same column (§8.25).
		let icon_gutter = self.items.iter().any(|item| item.icon.is_some());
		let selected = self
			.items
			.iter()
			.position(|item| item.is_highlighted)
			.unwrap_or(usize::MAX);
		let picker = Picker::new(&self.items, selected);

		for (idx, item) in self.items.iter().enumerate() {
			if item.is_separator {
				let sep = div()
					.w_full()
					.h(tokens.spacing(SpacingStep::S1))
					.bg(tokens.color(ColorRole::Hairline))
					.my(tokens.spacing(SpacingStep::S1));
				container = container.child(sep);
				continue;
			}

			let fg = match item.tone() {
				MenuRowTone::Refused => tokens.color(ColorRole::Muted),
				MenuRowTone::Destructive => tokens.color(ColorRole::ErrorInk),
				MenuRowTone::Offered => tokens.color(ColorRole::Foreground),
			};

			let mut row = div()
				.id(ElementId::from(idx))
				.px(item_pad_x)
				.py(item_pad_y)
				.rounded(tokens.radius(RadiusStep::Sm))
				.flex()
				.flex_row()
				.items_center()
				.justify_between()
				.gap(tokens.spacing(SpacingStep::S4));

			let mut left = div()
				.flex()
				.flex_row()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S2));

			if let Some(icon) = item.icon {
				left = left.child(Icon::new(icon).size(IconSize::Size14).color(fg));
			} else if icon_gutter {
				left = left.child(div().w(IconSize::Size14.pixels()));
			}

			left = left.child(
				div()
					.text_size(font_size)
					.text_color(fg)
					.child(item.label.clone()),
			);

			row = row.child(left);

			if let Some(shortcut) = &item.shortcut {
				row = row.child(
					div()
						.text_size(tokens.font_size(TextRamp::Small))
						.text_color(tokens.color(ColorRole::Muted))
						.child(shortcut.clone()),
				);
			}

			// A row that answers a click is hit-tested, lights under the pointer
			// and takes the pointing cursor; a row that answers none takes
			// neither, so a menu never states that a refused row is pressable.
			// The fill is the one every row surface lights with.
			// Where the keyboard stands is the selected fill, not a mark beside
			// the label: a walk moves it row to row the way a selection moves
			// everywhere else in the window, and the icon slot stays the row's.
			if picker.selection(idx, |row| !row.is_disabled && !row.is_separator)
				== SelectionState::Selected
			{
				row = row.bg(tokens.row_selected());
			}
			if matches!(
				picker.pointer(idx, true, |row| !row.is_disabled && !row.is_separator),
				PickerEvent::Confirm(_)
			) && let Some(handler) = &self.on_select
			{
				let h = Arc::clone(handler);
				row = row
					.cursor_pointer()
					.hover(move |style| style.bg(tokens.row_hover()))
					.on_click(move |ev, window, cx| h(idx, ev, window, cx));
			}

			container = container.child(row);
		}

		container
	}
}
