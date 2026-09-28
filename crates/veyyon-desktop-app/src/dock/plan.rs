//! The plan card: the plan's title and body, accepted as written or sent
//! back with the change the composer's draft states.

use gpui::{AnyElement, Context, Window, div, prelude::*};
use veyyon_desktop_model::PlanInteraction;
use veyyon_desktop_ui::{
	controls::ButtonVariant,
	markdown::{self, MarkdownStyle},
	theme::{ActiveTheme, TypeStyled, space, text},
};

use super::{
	InteractionDock,
	card::{Act, Choice, Control, plan_title},
	row::body_max,
};
use crate::state::Answer;

/// Accept first; refine hands the change to the composer.
pub(super) fn choices() -> Vec<Choice> {
	vec![
		Choice::send(
			"Accept",
			ButtonVariant::Primary,
			Answer::Plan { accepted: true, feedback: String::new() },
			Control::Accept,
		),
		Choice {
			label:   "Refine".into(),
			variant: ButtonVariant::Secondary,
			act:     Act::Composer,
		},
	]
}

impl InteractionDock {
	/// The plan's title and its body, parsed once when the card opened and
	/// scrolling past a share of the window.
	pub(super) fn render_plan(
		&self,
		plan: &PlanInteraction,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let title = plan_title(&plan.markdown_plan).to_owned();
		let body = self
			.shown
			.as_ref()
			.and_then(|shown| shown.plan.as_ref())
			.map(|doc| {
				let style = MarkdownStyle { prose: text::UI, ..MarkdownStyle::new("dock-plan-body") };
				div()
					.id("dock-plan-scroll")
					.max_h(body_max(window))
					.overflow_y_scroll()
					.child(markdown::render(doc, &style, window, cx))
			});
		div()
			.flex()
			.flex_col()
			.gap(space::S2)
			.child(
				div()
					.type_style(text::UI_MEDIUM)
					.text_color(palette.text.primary)
					.truncate()
					.child(title),
			)
			.children(body)
			.child(
				div()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child("To refine it, write the change in the composer and press Enter."),
			)
			.into_any_element()
	}
}
