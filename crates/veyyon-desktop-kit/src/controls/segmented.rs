//! Segmented control primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ElementId, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	controls::{ButtonSize, metrics::control_metrics},
	state::InteractiveState,
	token_set::{ColorRole, StrokeStep, TokenSet},
};

/// Segmented choice selector primitive element.
#[derive(IntoElement)]
pub struct Segmented {
	id:        Option<ElementId>,
	options:   Vec<SharedString>,
	selected:  usize,
	size:      ButtonSize,
	state:     InteractiveState,
	on_change: Option<Arc<dyn Fn(usize, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl Segmented {
	/// Creates a segmented control with option labels and initially selected
	/// index.
	#[must_use]
	pub fn new(options: impl IntoIterator<Item = impl Into<SharedString>>, selected: usize) -> Self {
		Self {
			id: None,
			options: options.into_iter().map(Into::into).collect(),
			selected,
			size: ButtonSize::Medium,
			state: InteractiveState::default(),
			on_change: None,
		}
	}

	/// Sets the element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets the control size; the height follows `control_height_px`.
	#[must_use]
	pub const fn size(mut self, size: ButtonSize) -> Self {
		self.size = size;
		self
	}

	/// Sets interactive state.
	#[must_use]
	pub const fn state(mut self, state: InteractiveState) -> Self {
		self.state = state;
		self
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

		// §6.10: a hairline frame, the chosen segment in foreground ink on a
		// hairline ground, the others in secondary ink with a hover wash. The
		// frame is the only edge; segments are separated by the hairline.
		let metrics = control_metrics(self.size, tokens);
		let stroke = tokens.stroke(StrokeStep::Hairline);
		let hairline = tokens.color(ColorRole::Hairline);
		let hover = tokens.row_hover();
		let disabled = self.state == InteractiveState::Disabled;
		let id = self.id.unwrap_or_else(|| ElementId::from("segmented"));

		let mut container = div()
			.id(id)
			.h(metrics.height)
			.rounded(metrics.radius)
			.border(stroke)
			.border_color(hairline)
			.overflow_hidden()
			.flex()
			.items_center()
			.text_size(tokens.font_size(metrics.ramp))
			.line_height(tokens.line_height(metrics.ramp));

		let count = self.options.len();
		for (idx, label) in self.options.into_iter().enumerate() {
			let is_selected = idx == self.selected;
			let (seg_bg, seg_fg) = if is_selected {
				(hairline, tokens.color(ColorRole::Foreground))
			} else {
				(tokens.transparent(), tokens.color(ColorRole::Secondary))
			};

			let mut segment = div()
				.id(ElementId::from(idx))
				.h_full()
				.px(metrics.inset)
				.bg(seg_bg)
				.flex()
				.items_center()
				.justify_center()
				.text_color(seg_fg)
				.whitespace_nowrap()
				.child(label);

			if !disabled {
				segment = segment.cursor_pointer();
				if !is_selected {
					segment = segment.hover(move |style| style.bg(hover));
				}
				if let Some(handler) = &self.on_change {
					let h = Arc::clone(handler);
					segment = segment.on_click(move |_, window, cx| h(idx, window, cx));
				}
			}

			container = container.child(segment);
			if idx + 1 < count {
				container = container.child(div().w(stroke).h_full().bg(hairline));
			}
		}

		if disabled {
			container = container.opacity(metrics.disabled_opacity);
		}
		container
	}
}
