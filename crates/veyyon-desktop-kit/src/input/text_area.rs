//! Text area multiline input primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ElementId, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	state::InteractiveState,
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// Multiline text input area primitive element.
#[derive(IntoElement)]
pub struct TextArea {
	id:          Option<ElementId>,
	value:       SharedString,
	placeholder: SharedString,
	state:       InteractiveState,
	rows:        usize,
	on_change:   Option<Arc<dyn Fn(SharedString, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl TextArea {
	/// Creates a text area with text content.
	#[must_use]
	pub fn new(value: impl Into<SharedString>) -> Self {
		Self {
			id:          None,
			value:       value.into(),
			placeholder: SharedString::default(),
			state:       InteractiveState::default(),
			rows:        4,
			on_change:   None,
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

	/// Sets interactive state.
	#[must_use]
	pub fn state(mut self, state: InteractiveState) -> Self {
		self.state = state;
		self
	}

	/// Sets initial row count height.
	#[must_use]
	pub fn rows(mut self, rows: usize) -> Self {
		self.rows = rows.max(1);
		self
	}

	/// Sets change callback.
	#[must_use]
	pub fn on_change(
		mut self,
		handler: impl Fn(SharedString, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_change = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for TextArea {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let (bg, border_color, fg) = match self.state {
			InteractiveState::Disabled => (
				tokens.color(ColorRole::Inset),
				tokens.color(ColorRole::Hairline),
				tokens.color(ColorRole::Muted),
			),
			InteractiveState::Focused => (
				tokens.color(ColorRole::Inset),
				tokens.color(ColorRole::Focus),
				tokens.color(ColorRole::Foreground),
			),
			_ => (
				tokens.color(ColorRole::Inset),
				tokens.color(ColorRole::Hairline),
				tokens.color(ColorRole::Foreground),
			),
		};

		let pad_x = tokens.spacing(SpacingStep::S3);
		let pad_y = tokens.spacing(SpacingStep::S2);
		let radius = tokens.radius(RadiusStep::Md);
		let font_size = tokens.font_size(TextRamp::Body);
		let line_h = tokens.line_height(TextRamp::Body);

		let text = if self.value.is_empty() {
			self.placeholder
		} else {
			self.value
		};

		let id = self.id.unwrap_or_else(|| ElementId::from("text-area"));
		div()
			.id(id)
			.w_full()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.px(pad_x)
			.py(pad_y)
			.text_size(font_size)
			.line_height(line_h)
			.text_color(fg)
			.overflow_hidden()
			.child(text)
	}
}
