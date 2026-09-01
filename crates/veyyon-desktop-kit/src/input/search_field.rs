//! Search field input primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ElementId, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	icons::{Icon, IconName, IconSize},
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// Search field primitive with search icon, clear button, and placeholder.
#[derive(IntoElement)]
pub struct SearchField {
	id:          Option<ElementId>,
	value:       SharedString,
	placeholder: SharedString,
	on_change:   Option<Arc<dyn Fn(SharedString, &mut Window, &mut App) + Send + Sync + 'static>>,
	on_clear:    Option<Arc<dyn Fn(&mut Window, &mut App) + Send + Sync + 'static>>,
}

impl SearchField {
	/// Creates a search field with current query value.
	#[must_use]
	pub fn new(value: impl Into<SharedString>) -> Self {
		Self {
			id:          None,
			value:       value.into(),
			placeholder: "Search...".into(),
			on_change:   None,
			on_clear:    None,
		}
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets placeholder text.
	#[must_use]
	pub fn placeholder(mut self, placeholder: impl Into<SharedString>) -> Self {
		self.placeholder = placeholder.into();
		self
	}

	/// Sets text change callback.
	#[must_use]
	pub fn on_change(
		mut self,
		handler: impl Fn(SharedString, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_change = Some(Arc::new(handler));
		self
	}

	/// Sets clear button callback.
	#[must_use]
	pub fn on_clear(
		mut self,
		handler: impl Fn(&mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_clear = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for SearchField {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Inset);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Md);
		let pad_x = tokens.spacing(SpacingStep::S3);
		let pad_y = tokens.spacing(SpacingStep::S2);
		let gap = tokens.spacing(SpacingStep::S2);

		let has_value = !self.value.is_empty();
		let (text, text_color) = if has_value {
			(self.value.clone(), tokens.color(ColorRole::Foreground))
		} else {
			(self.placeholder, tokens.color(ColorRole::Placeholder))
		};

		let id = self.id.unwrap_or_else(|| ElementId::from("search-field"));
		let mut el = div()
			.id(id)
			.w_full()
			.max_w_full()
			.min_w_0()
			.overflow_hidden()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.px(pad_x)
			.py(pad_y)
			.flex()
			.items_center()
			.gap(gap)
			.child(
				div().flex_shrink_0().child(
					Icon::new(IconName::Search)
						.size(IconSize::Size14)
						.color(tokens.color(ColorRole::Secondary)),
				),
			)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.overflow_hidden()
					.whitespace_nowrap()
					.truncate()
					.text_size(tokens.font_size(TextRamp::Body))
					.text_color(text_color)
					.child(text),
			);

		if has_value {
			let mut clear_btn = div()
				.id(ElementId::from("clear-btn"))
				.cursor_pointer()
				.child(
					Icon::new(IconName::Close)
						.size(IconSize::Size12)
						.color(tokens.color(ColorRole::Secondary)),
				);

			if let Some(handler) = self.on_clear {
				clear_btn = clear_btn.on_click(move |_, window, cx| handler(window, cx));
			}

			el = el.child(clear_btn);
		}

		el
	}
}
