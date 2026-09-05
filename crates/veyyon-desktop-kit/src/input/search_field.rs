//! Search field input primitive wrapping an Editor entity (§8.25).

use std::sync::Arc;

use veyyon_gpui::{
	AnyElement, App, ElementId, IntoElement, Pixels, RenderOnce, SharedString, Window, div,
	prelude::*,
};

use super::editor::slot::EditorSlot;
use crate::{
	controls::{ButtonSize, IconButton, metrics::control_metrics},
	icons::{Icon, IconName, IconSize},
	token_set::{ColorRole, StrokeStep, TokenSet},
};

/// Search field primitive with search icon, clear button, and placeholder.
#[derive(IntoElement)]
pub struct SearchField {
	id:          Option<ElementId>,
	editor:      EditorSlot,
	placeholder: SharedString,
	trailing:    Option<AnyElement>,
	height:      Option<Pixels>,
	flush:       bool,
	on_change:   Option<Arc<dyn Fn(SharedString, &mut Window, &mut App) + Send + Sync + 'static>>,
	on_clear:    Option<Arc<dyn Fn(&mut Window, &mut App) + Send + Sync + 'static>>,
}

impl SearchField {
	/// Creates a search field wrapping an editor slot.
	#[must_use]
	pub fn new(editor: impl Into<EditorSlot>) -> Self {
		Self {
			id:          None,
			editor:      editor.into(),
			placeholder: "Search...".into(),
			trailing:    None,
			height:      None,
			flush:       false,
			on_change:   None,
			on_clear:    None,
		}
	}

	/// Sets the trailing slot, drawn after the text and before the clear
	/// control.
	#[must_use]
	pub fn trailing(mut self, element: impl IntoElement) -> Self {
		self.trailing = Some(element.into_any_element());
		self
	}

	/// Sets a fixed height from a surface's tokens.
	#[must_use]
	pub fn height(mut self, height: Pixels) -> Self {
		self.height = Some(height);
		self
	}

	/// Draws the field without its own edge and radius, for a field that is
	/// the top row of a float whose edge it shares.
	#[must_use]
	pub fn flush(mut self, flush: bool) -> Self {
		self.flush = flush;
		self
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
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		// §6.10: no ground, a hairline edge that rises to focus, and the icon in
		// secondary ink. The clear control appears only once there is text to
		// clear, so an empty field shows one glyph.
		let metrics = control_metrics(ButtonSize::Medium, tokens);
		let focused = self
			.editor
			.entity()
			.is_some_and(|ed| ed.read(cx).focus_handle().is_focused(window));
		let edge = if focused {
			tokens.color(ColorRole::Focus)
		} else {
			tokens.color(ColorRole::Hairline)
		};
		let has_value = match &self.editor {
			EditorSlot::Entity(entity) => !entity.read(cx).text().is_empty(),
			EditorSlot::Static(val) => !val.is_empty(),
		};

		let id = self.id.unwrap_or_else(|| ElementId::from("search-field"));
		let mut container = div()
			.id(id)
			.h(self.height.unwrap_or(metrics.height))
			.w_full()
			.min_w_0()
			.overflow_hidden()
			.px(metrics.inset)
			.flex()
			.items_center()
			.gap(metrics.gap)
			.text_size(tokens.font_size(metrics.ramp))
			.line_height(tokens.line_height(metrics.ramp))
			.child(
				div().flex_shrink_0().child(
					Icon::new(IconName::Search)
						.size(IconSize::Size14)
						.color(tokens.color(ColorRole::Secondary)),
				),
			);
		if !self.flush {
			container = container
				.rounded(metrics.radius)
				.border(tokens.stroke(StrokeStep::Hairline))
				.border_color(edge);
		}

		match self.editor {
			EditorSlot::Entity(entity) => {
				container = container
					.cursor_text()
					.child(div().flex_1().min_w_0().child(entity));
			},
			EditorSlot::Static(val) => {
				let (text, text_color) = if has_value {
					(val, tokens.color(ColorRole::Foreground))
				} else {
					(self.placeholder, tokens.color(ColorRole::Placeholder))
				};
				container = container.child(
					div()
						.flex_1()
						.min_w_0()
						.overflow_hidden()
						.whitespace_nowrap()
						.truncate()
						.text_color(text_color)
						.child(text),
				);
			},
		}

		if let Some(trailing) = self.trailing {
			container = container.child(div().flex_shrink_0().child(trailing));
		}

		if let (true, Some(on_clear)) = (has_value, self.on_clear) {
			container = container.child(
				IconButton::new(IconName::Close)
					.id("search-field-clear")
					.size(IconSize::Size12)
					.on_click(move |_, window, cx| on_clear(window, cx)),
			);
		}

		container
	}
}
