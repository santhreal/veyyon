//! Context Menu / Dropdown Menu container primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ClickEvent, ElementId, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::{
	icons::{Icon, IconSize},
	state::MenuItem,
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

		for (idx, item) in self.items.into_iter().enumerate() {
			if item.is_separator {
				let sep = div()
					.w_full()
					.h(tokens.spacing(SpacingStep::S1))
					.bg(tokens.color(ColorRole::Hairline))
					.my(tokens.spacing(SpacingStep::S1));
				container = container.child(sep);
				continue;
			}

			let fg = if item.is_disabled {
				tokens.color(ColorRole::Muted)
			} else if item.is_danger {
				tokens.color(ColorRole::ErrorFill)
			} else {
				tokens.color(ColorRole::Foreground)
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
				.gap(tokens.spacing(SpacingStep::S4))
				.cursor_pointer();

			let mut left = div()
				.flex()
				.flex_row()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S2));

			if let Some(icon) = item.icon {
				left = left.child(Icon::new(icon).size(IconSize::Size14).color(fg));
			}

			left = left.child(div().text_size(font_size).text_color(fg).child(item.label));

			row = row.child(left);

			if let Some(shortcut) = item.shortcut {
				row = row.child(
					div()
						.text_size(tokens.font_size(TextRamp::Small))
						.text_color(tokens.color(ColorRole::Muted))
						.child(shortcut),
				);
			}

			if !item.is_disabled {
				if let Some(ref handler) = self.on_select {
					let h = Arc::clone(handler);
					row = row.on_click(move |ev, window, cx| h(idx, ev, window, cx));
				}
			}

			container = container.child(row);
		}

		container
	}
}
