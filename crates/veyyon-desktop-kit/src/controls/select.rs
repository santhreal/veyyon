//! Select trigger primitive (§8.25).
//!
//! A select shows the chosen value and opens a picker; it never cycles
//! through its values on a click, because the operator cannot see the others
//! before committing to one (§6.10). The picker is the caller's: a surface
//! opens the palette in a picking mode from `on_open`.

use std::sync::Arc;

use veyyon_gpui::{
	App, CursorStyle, ElementId, IntoElement, RenderOnce, SharedString, Window, div, prelude::*,
};

use crate::{
	controls::{ButtonSize, metrics::control_metrics},
	icons::{Icon, IconName, IconSize},
	state::InteractiveState,
	token_set::{ColorRole, StrokeStep, TokenSet},
};

/// Dropdown select trigger element.
#[derive(IntoElement)]
pub struct Select {
	id:       Option<ElementId>,
	options:  Vec<SharedString>,
	selected: usize,
	is_open:  bool,
	size:     ButtonSize,
	state:    InteractiveState,
	on_open:  Option<Arc<dyn Fn(&mut Window, &mut App) + Send + Sync + 'static>>,
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
			size: ButtonSize::Medium,
			state: InteractiveState::default(),
			on_open: None,
		}
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets open state, which flips the chevron.
	#[must_use]
	pub const fn open(mut self, is_open: bool) -> Self {
		self.is_open = is_open;
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

	/// Sets the handler a click opens the picker with.
	#[must_use]
	pub fn on_open(
		mut self,
		handler: impl Fn(&mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_open = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for Select {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		// §6.10: no ground, a hairline edge, foreground ink for the value and
		// secondary ink for the chevron; the open state raises the edge to focus.
		let metrics = control_metrics(self.size, tokens);
		let edge = if self.is_open {
			tokens.color(ColorRole::Focus)
		} else {
			tokens.color(ColorRole::Hairline)
		};
		let hover = tokens.row_hover();
		let disabled = self.state == InteractiveState::Disabled;
		let cursor = if disabled {
			CursorStyle::OperationNotAllowed
		} else {
			CursorStyle::PointingHand
		};

		let current_label = self
			.options
			.get(self.selected)
			.cloned()
			.unwrap_or_else(|| "Choose".into());
		let icon = if self.is_open {
			IconName::ChevronUp
		} else {
			IconName::ChevronDown
		};

		let id = self.id.unwrap_or_else(|| ElementId::from("select-trigger"));
		let mut el = div()
			.id(id)
			.h(metrics.height)
			.w_full()
			.min_w_0()
			.overflow_hidden()
			.rounded(metrics.radius)
			.border(tokens.stroke(StrokeStep::Hairline))
			.border_color(edge)
			.px(metrics.inset)
			.flex()
			.items_center()
			.justify_between()
			.gap(metrics.gap)
			.cursor(cursor)
			.child(
				div()
					.min_w_0()
					.flex_1()
					.overflow_hidden()
					.whitespace_nowrap()
					.truncate()
					.text_size(tokens.font_size(metrics.ramp))
					.line_height(tokens.line_height(metrics.ramp))
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

		if disabled {
			el = el.opacity(metrics.disabled_opacity);
		} else {
			el = el.hover(move |style| style.bg(hover));
			if let Some(handler) = self.on_open {
				el = el.on_click(move |_, window, cx| handler(window, cx));
			}
		}

		el
	}
}
