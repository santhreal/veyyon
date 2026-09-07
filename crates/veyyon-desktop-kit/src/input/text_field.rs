//! Text field single-line input primitive over an Editor entity (§8.25).
//!
//! The field takes the editor itself, never a value: an element is rebuilt
//! every frame, so a field constructed from a string keeps no keystroke and
//! whatever reads it back gets the string it was built with. A value on
//! display is text, not a field.

use veyyon_gpui::{App, ElementId, Entity, IntoElement, RenderOnce, Window, div, prelude::*};

use super::editor::Editor;
use crate::{
	controls::{ButtonSize, metrics::control_metrics},
	state::InteractiveState,
	token_set::{ColorRole, StrokeStep, TokenSet},
};

/// Single-line text input field primitive element.
#[derive(IntoElement)]
pub struct TextField {
	id:     Option<ElementId>,
	editor: Entity<Editor>,
	state:  InteractiveState,
}

impl TextField {
	/// Creates a text field over `editor`, which holds the value and the
	/// placeholder it draws when empty.
	#[must_use]
	pub fn new(editor: Entity<Editor>) -> Self {
		Self { id: None, editor, state: InteractiveState::default() }
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets interactive state.
	#[must_use]
	pub fn state(mut self, state: InteractiveState) -> Self {
		self.state = state;
		self
	}
}

impl RenderOnce for TextField {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let is_entity_focused = self.editor.read(cx).focus_handle().is_focused(window);

		// §6.10: no ground and a hairline edge; focus raises the edge to the
		// focus role and nothing else moves.
		let metrics = control_metrics(ButtonSize::Medium, tokens);
		let focused = self.state == InteractiveState::Focused || is_entity_focused;
		let disabled = self.state == InteractiveState::Disabled;
		let edge = if focused {
			tokens.color(ColorRole::Focus)
		} else {
			tokens.color(ColorRole::Hairline)
		};

		let id = self.id.unwrap_or_else(|| ElementId::from("text-field"));
		let mut container = div()
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
			.text_size(tokens.font_size(metrics.ramp))
			.line_height(tokens.line_height(metrics.ramp))
			.text_color(tokens.color(ColorRole::Foreground));
		if disabled {
			container = container
				.opacity(metrics.disabled_opacity)
				.cursor_not_allowed();
		} else {
			container = container.cursor_text();
		}

		container.child(div().flex_1().min_w_0().child(self.editor))
	}
}
