//! Selection controls: Checkbox and Radio primitives (§8.25).

use std::sync::Arc;

use veyyon_gpui::{App, ElementId, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	icons::{Icon, IconName, IconSize},
	state::InteractiveState,
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// Checkbox selection state including indeterminate tri-state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum CheckboxState {
	#[default]
	Unchecked,
	Checked,
	Indeterminate,
}

/// Checkbox selection control primitive.
#[derive(IntoElement)]
pub struct Checkbox {
	id:        Option<ElementId>,
	state:     CheckboxState,
	label:     Option<SharedString>,
	interact:  InteractiveState,
	on_toggle: Option<Arc<dyn Fn(CheckboxState, &mut Window, &mut App) + Send + Sync + 'static>>,
}

impl Checkbox {
	/// Creates a checkbox with current checked state.
	#[must_use]
	pub fn new(state: CheckboxState) -> Self {
		Self { id: None, state, label: None, interact: InteractiveState::default(), on_toggle: None }
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets label text.
	#[must_use]
	pub fn label(mut self, label: impl Into<SharedString>) -> Self {
		self.label = Some(label.into());
		self
	}

	/// Sets interactive state.
	#[must_use]
	pub fn state(mut self, interact: InteractiveState) -> Self {
		self.interact = interact;
		self
	}

	/// Sets toggle handler.
	#[must_use]
	pub fn on_toggle(
		mut self,
		handler: impl Fn(CheckboxState, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_toggle = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for Checkbox {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let box_size = tokens.spacing(SpacingStep::S6);
		let radius = tokens.radius(RadiusStep::Sm);
		// §6.10: unchecked is a hairline-edged transparent box; checked is the
		// accent. The edge is drawn in both states so the box never resizes.
		let (bg, border_color) = match self.state {
			CheckboxState::Unchecked => (tokens.transparent(), tokens.color(ColorRole::Hairline)),
			CheckboxState::Checked | CheckboxState::Indeterminate => {
				(tokens.color(ColorRole::Accent), tokens.color(ColorRole::Accent))
			},
		};
		let disabled = self.interact == InteractiveState::Disabled;

		let icon = match self.state {
			CheckboxState::Checked => Some(IconName::Check),
			CheckboxState::Indeterminate => Some(IconName::Minus),
			CheckboxState::Unchecked => None,
		};

		let mut box_el = div()
			.size(box_size)
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.flex()
			.items_center()
			.justify_center();

		if let Some(icon_name) = icon {
			box_el = box_el.child(
				Icon::new(icon_name)
					.size(IconSize::Size12)
					.color(tokens.color(ColorRole::AccentForeground)),
			);
		}

		let id = self.id.unwrap_or_else(|| ElementId::from("checkbox"));
		let mut row = div()
			.id(id)
			.flex()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S2))
			.child(box_el);

		if let Some(label) = self.label {
			row = row.child(
				div()
					.text_size(tokens.font_size(TextRamp::Body))
					.line_height(tokens.line_height(TextRamp::Body))
					.text_color(tokens.color(ColorRole::Foreground))
					.child(label),
			);
		}

		if disabled {
			return row.opacity(0.4).cursor_not_allowed();
		}
		row = row.cursor_pointer();
		if let Some(handler) = self.on_toggle {
			let next_state = match self.state {
				CheckboxState::Unchecked => CheckboxState::Checked,
				CheckboxState::Checked | CheckboxState::Indeterminate => CheckboxState::Unchecked,
			};
			row = row.on_click(move |_, window, cx| handler(next_state, window, cx));
		}

		row
	}
}

/// Radio button single-choice primitive.
#[derive(IntoElement)]
pub struct Radio {
	id:        Option<ElementId>,
	selected:  bool,
	label:     Option<SharedString>,
	interact:  InteractiveState,
	on_select: Option<Arc<dyn Fn(&mut Window, &mut App) + Send + Sync + 'static>>,
}

impl Radio {
	/// Creates a radio button with selection state.
	#[must_use]
	pub fn new(selected: bool) -> Self {
		Self {
			id: None,
			selected,
			label: None,
			interact: InteractiveState::default(),
			on_select: None,
		}
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets label text.
	#[must_use]
	pub fn label(mut self, label: impl Into<SharedString>) -> Self {
		self.label = Some(label.into());
		self
	}

	/// Sets interactive state.
	#[must_use]
	pub fn state(mut self, interact: InteractiveState) -> Self {
		self.interact = interact;
		self
	}

	/// Sets select handler.
	#[must_use]
	pub fn on_select(
		mut self,
		handler: impl Fn(&mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_select = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for Radio {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let outer_size = tokens.spacing(SpacingStep::S6);
		let inner_size = tokens.spacing(SpacingStep::S2);
		let radius = tokens.radius(RadiusStep::Full);

		// §6.10: the ring is the hairline at rest and the accent when chosen;
		// the dot is the accent. Neither state has a neutral fill.
		let (border_color, inner_bg) = if self.selected {
			(tokens.color(ColorRole::Accent), tokens.color(ColorRole::Accent))
		} else {
			(tokens.color(ColorRole::Hairline), tokens.transparent())
		};
		let disabled = self.interact == InteractiveState::Disabled;

		let inner_dot = div().size(inner_size).bg(inner_bg).rounded(radius);

		let outer_circle = div()
			.size(outer_size)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.flex()
			.items_center()
			.justify_center()
			.child(inner_dot);

		let id = self.id.unwrap_or_else(|| ElementId::from("radio"));
		let mut row = div()
			.id(id)
			.flex()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S2))
			.child(outer_circle);

		if let Some(label) = self.label {
			row = row.child(
				div()
					.text_size(tokens.font_size(TextRamp::Body))
					.line_height(tokens.line_height(TextRamp::Body))
					.text_color(tokens.color(ColorRole::Foreground))
					.child(label),
			);
		}

		if disabled {
			return row.opacity(0.4).cursor_not_allowed();
		}
		row = row.cursor_pointer();
		if let Some(handler) = self.on_select {
			row = row.on_click(move |_, window, cx| handler(window, cx));
		}

		row
	}
}
