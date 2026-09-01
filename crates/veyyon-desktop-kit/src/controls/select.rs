//! Select dropdown trigger primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ElementId, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	icons::{Icon, IconName, IconSize},
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// Dropdown select trigger element.
#[derive(IntoElement)]
pub struct Select {
	id:        Option<ElementId>,
	options:   Vec<SharedString>,
	selected:  usize,
	is_open:   bool,
	on_select: Option<Arc<dyn Fn(usize, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl Select {
	/// Creates a select trigger with options list and selected index.
	#[must_use]
	pub fn new(options: impl IntoIterator<Item = impl Into<SharedString>>, selected: usize) -> Self {
		Self {
			id: None,
			options: options.into_iter().map(Into::into).collect(),
			selected,
			is_open: false,
			on_select: None,
		}
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets open state.
	#[must_use]
	pub fn open(mut self, is_open: bool) -> Self {
		self.is_open = is_open;
		self
	}

	/// Sets selection change callback.
	#[must_use]
	pub fn on_select(
		mut self,
		handler: impl Fn(usize, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_select = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for Select {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Inset);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Md);
		let pad_x = tokens.spacing(SpacingStep::S3);
		let pad_y = tokens.spacing(SpacingStep::S2);

		let current_label = self
			.options
			.get(self.selected)
			.cloned()
			.unwrap_or_else(|| "Select...".into());

		let icon = if self.is_open {
			IconName::ChevronUp
		} else {
			IconName::ChevronDown
		};

		let id = self.id.unwrap_or_else(|| ElementId::from("select-trigger"));
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
			.justify_between()
			.gap(tokens.spacing(SpacingStep::S2))
			.cursor_pointer()
			.child(
				div()
					.min_w_0()
					.flex_1()
					.overflow_hidden()
					.whitespace_nowrap()
					.truncate()
					.text_size(tokens.font_size(TextRamp::Body))
					.text_color(tokens.color(ColorRole::Foreground))
					.child(current_label),
			)
			.child(
				div().flex_shrink_0().child(
					Icon::new(icon)
						.size(IconSize::Size12)
						.color(tokens.color(ColorRole::Secondary)),
				),
			);

		if let Some(handler) = self.on_select {
			let total = self.options.len();
			let next_idx = if total > 0 {
				(self.selected + 1) % total
			} else {
				0
			};
			el = el.on_click(move |_, window, cx| handler(next_idx, window, cx));
		}

		el
	}
}
