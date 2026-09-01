//! Segmented control primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ElementId, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet};

/// Segmented choice selector primitive element.
#[derive(IntoElement)]
pub struct Segmented {
	options:   Vec<SharedString>,
	selected:  usize,
	on_change: Option<Arc<dyn Fn(usize, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl Segmented {
	/// Creates a segmented control with option labels and initially selected
	/// index.
	#[must_use]
	pub fn new(options: impl IntoIterator<Item = impl Into<SharedString>>, selected: usize) -> Self {
		Self { options: options.into_iter().map(Into::into).collect(), selected, on_change: None }
	}

	/// Sets index change handler.
	#[must_use]
	pub fn on_change(
		mut self,
		handler: impl Fn(usize, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_change = Some(Arc::new(handler));
		self
	}
}

/// Alias for `Segmented` adhering to §6.7 naming.
pub type SegmentedControl = Segmented;

impl RenderOnce for Segmented {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Inset);
		let radius = tokens.radius(RadiusStep::Md);
		let pad = tokens.spacing(SpacingStep::S1);
		let gap = tokens.spacing(SpacingStep::S1);

		let mut container = div()
			.bg(bg)
			.rounded(radius)
			.p(pad)
			.flex()
			.items_center()
			.gap(gap);

		for (idx, label) in self.options.into_iter().enumerate() {
			let is_selected = idx == self.selected;
			let seg_bg = if is_selected {
				tokens.color(ColorRole::Float)
			} else {
				tokens.transparent()
			};
			let seg_fg = if is_selected {
				tokens.color(ColorRole::Foreground)
			} else {
				tokens.color(ColorRole::Secondary)
			};

			let mut segment = div()
				.id(ElementId::from(idx))
				.bg(seg_bg)
				.rounded(tokens.radius(RadiusStep::Sm))
				.px(tokens.spacing(SpacingStep::S3))
				.py(tokens.spacing(SpacingStep::S1))
				.text_size(tokens.font_size(TextRamp::Small))
				.text_color(seg_fg)
				.cursor_pointer()
				.child(label);

			if let Some(ref handler) = self.on_change {
				let h = Arc::clone(handler);
				segment = segment.on_click(move |_, window, cx| h(idx, window, cx));
			}

			container = container.child(segment);
		}

		container
	}
}
