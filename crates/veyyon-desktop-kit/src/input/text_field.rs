//! Text field single-line input primitive wrapping an Editor entity (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ElementId, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use super::editor::slot::EditorSlot;
use crate::{
	controls::{ButtonSize, metrics::control_metrics},
	state::InteractiveState,
	token_set::{ColorRole, StrokeStep, TokenSet},
};

/// Single-line text input field primitive element.
#[derive(IntoElement)]
pub struct TextField {
	id:          Option<ElementId>,
	editor:      EditorSlot,
	placeholder: SharedString,
	state:       InteractiveState,
	on_change:   Option<Arc<dyn Fn(SharedString, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl TextField {
	/// Creates a text field wrapping an editor slot.
	#[must_use]
	pub fn new(editor: impl Into<EditorSlot>) -> Self {
		Self {
			id:          None,
			editor:      editor.into(),
			placeholder: SharedString::default(),
			state:       InteractiveState::default(),
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

impl RenderOnce for TextField {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let is_entity_focused = self
			.editor
			.entity()
			.is_some_and(|ed| ed.read(cx).focus_handle().is_focused(window));

		// §6.10: no ground and a hairline edge; focus raises the edge to the
		// focus role and nothing else moves. A static slot is a value on
		// display, not an input, so it takes no text cursor.
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
		} else if self.editor.is_entity() {
			container = container.cursor_text();
		}

		match self.editor {
			EditorSlot::Entity(entity) => container.child(div().flex_1().min_w_0().child(entity)),
			EditorSlot::Static(val) => {
				let (text, ink) = if val.is_empty() {
					(self.placeholder, tokens.color(ColorRole::Placeholder))
				} else {
					(val, tokens.color(ColorRole::Foreground))
				};
				container.child(
					div()
						.flex_1()
						.min_w_0()
						.overflow_hidden()
						.whitespace_nowrap()
						.truncate()
						.text_color(ink)
						.child(text),
				)
			},
		}
	}
}
