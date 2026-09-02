//! NumberInput stepper control primitive (§8.25).

use std::rc::Rc;

use veyyon_gpui::{App, ElementId, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::{
	controls::{ButtonSize, metrics::control_metrics},
	icons::{Icon, IconName, IconSize},
	token_set::{ColorRole, SpacingStep, StrokeStep, TokenSet},
};

/// Numeric input field with increment/decrement stepper controls.
#[derive(IntoElement)]
pub struct NumberInput {
	id:        Option<ElementId>,
	value:     i64,
	min:       i64,
	max:       i64,
	step:      i64,
	disabled:  bool,
	on_change: Option<Box<dyn Fn(i64, &mut Window, &mut App) + 'static>>,
}

impl NumberInput {
	/// Creates a number input with initial value.
	#[must_use]
	pub fn new(value: i64) -> Self {
		Self {
			id: None,
			value,
			min: i64::MIN,
			max: i64::MAX,
			step: 1,
			disabled: false,
			on_change: None,
		}
	}

	/// Sets the element ID; two inputs in one surface need distinct ids.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets minimum and maximum value bounds.
	#[must_use]
	pub fn range(mut self, min: i64, max: i64) -> Self {
		self.min = min;
		self.max = max;
		self
	}

	/// Sets stepper increment/decrement step.
	#[must_use]
	pub fn step(mut self, step: i64) -> Self {
		self.step = step;
		self
	}

	/// Configures disabled state.
	#[must_use]
	pub fn disabled(mut self, disabled: bool) -> Self {
		self.disabled = disabled;
		self
	}

	/// Attaches value change event handler.
	#[must_use]
	pub fn on_change(mut self, handler: impl Fn(i64, &mut Window, &mut App) + 'static) -> Self {
		self.on_change = Some(Box::new(handler));
		self
	}
}

impl RenderOnce for NumberInput {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		// §6.10: no ground, a hairline edge, the value in foreground ink and the
		// steppers as square text controls inside the frame. A stepper at its
		// bound is drawn at rest and does nothing, so the value never leaves
		// the range.
		let metrics = control_metrics(ButtonSize::Medium, tokens);
		let stroke = tokens.stroke(StrokeStep::Hairline);
		let hairline = tokens.color(ColorRole::Hairline);
		let hover = tokens.row_hover();
		let stepper = metrics.height - stroke - stroke;
		let value_text = self.value.to_string();
		let handler = self.on_change.map(Rc::new);

		let step_button = |name: &'static str, icon: IconName, target: Option<i64>| {
			let mut button = div()
				.id(ElementId::from(name))
				.w(stepper)
				.h_full()
				.flex_shrink_0()
				.flex()
				.items_center()
				.justify_center()
				.child(
					Icon::new(icon)
						.size(IconSize::Size12)
						.color(tokens.color(ColorRole::Secondary)),
				);
			if let (Some(target), Some(handler), false) = (target, handler.clone(), self.disabled) {
				button = button
					.cursor_pointer()
					.hover(move |style| style.bg(hover))
					.on_click(move |_, window, cx| handler(target, window, cx));
			}
			button
		};
		let lower =
			(self.value > self.min).then(|| self.value.saturating_sub(self.step).max(self.min));
		let higher =
			(self.value < self.max).then(|| self.value.saturating_add(self.step).min(self.max));

		let mut container = div()
			.id(self.id.unwrap_or_else(|| ElementId::from("number-input")))
			.h(metrics.height)
			.rounded(metrics.radius)
			.border(stroke)
			.border_color(hairline)
			.overflow_hidden()
			.flex()
			.flex_row()
			.items_center()
			.child(step_button("number-input-decrement", IconName::Minus, lower))
			.child(div().w(stroke).h_full().bg(hairline))
			.child(
				div()
					.min_w(tokens.spacing(SpacingStep::S12))
					.px(metrics.gap)
					.flex()
					.justify_center()
					.text_size(tokens.font_size(metrics.ramp))
					.line_height(tokens.line_height(metrics.ramp))
					.text_color(tokens.color(ColorRole::Foreground))
					.child(value_text),
			)
			.child(div().w(stroke).h_full().bg(hairline))
			.child(step_button("number-input-increment", IconName::Plus, higher));

		if self.disabled {
			container = container
				.opacity(metrics.disabled_opacity)
				.cursor_not_allowed();
		}

		container
	}
}
