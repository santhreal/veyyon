//! Modal Dialog primitive (§8.25).

use veyyon_gpui::{
	AnyElement, App, ClickEvent, ElementId, IntoElement, RenderOnce, SharedString, Window, div,
	prelude::*,
};

use crate::{
	controls::button::Button,
	state::DialogButtonSpec,
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// The click handler an action button dispatches through.
type ActionHandler = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// Modal dialog float container with title header, body slot, and action button
/// row.
#[derive(IntoElement)]
pub struct Dialog {
	id:      ElementId,
	title:   SharedString,
	body:    AnyElement,
	actions: Vec<(DialogButtonSpec, Option<ActionHandler>)>,
}

impl Dialog {
	/// Creates a dialog with title and body element.
	#[must_use]
	pub fn new(title: impl Into<SharedString>, body: impl IntoElement) -> Self {
		Self {
			id:      ElementId::from("dialog"),
			title:   title.into(),
			body:    body.into_any_element(),
			actions: Vec::new(),
		}
	}

	/// Sets the element id the action buttons derive theirs from.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = id.into();
		self
	}

	/// Appends an action button that answers no click: a label the caller
	/// closes the dialog around by other means.
	#[must_use]
	pub fn action(mut self, action: DialogButtonSpec) -> Self {
		self.actions.push((action, None));
		self
	}

	/// Appends an action button with the click it dispatches.
	#[must_use]
	pub fn action_on_click(
		mut self,
		action: DialogButtonSpec,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.actions.push((action, Some(Box::new(handler))));
		self
	}
}

impl RenderOnce for Dialog {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Float);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Xl);
		let pad = tokens.spacing(SpacingStep::S6);
		let gap = tokens.spacing(SpacingStep::S4);

		let header = div()
			.w_full()
			.min_w_0()
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.text_size(tokens.font_size(TextRamp::Head))
			.line_height(tokens.line_height(TextRamp::Head))
			.text_color(tokens.color(ColorRole::Foreground))
			.child(self.title);

		let mut action_row = div()
			.flex()
			.flex_row()
			.items_center()
			.justify_end()
			.gap(tokens.spacing(SpacingStep::S2));

		for (index, (action, handler)) in self.actions.into_iter().enumerate() {
			let id = ElementId::NamedChild(
				std::sync::Arc::new(self.id.clone()),
				format!("action-{index}").into(),
			);
			let mut btn = Button::new(action.label).id(id).variant(action.variant);
			if let Some(handler) = handler {
				btn = btn.on_click(handler);
			}
			action_row = action_row.child(btn);
		}

		div()
			.w_full()
			.max_w_full()
			.overflow_hidden()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.p(pad)
			.shadow_lg()
			.flex()
			.flex_col()
			.gap(gap)
			.child(header)
			.child(div().w_full().min_w_0().overflow_hidden().child(self.body))
			.child(action_row)
	}
}
