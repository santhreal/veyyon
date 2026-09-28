//! The approval card: the call the agent wants to run and the four answers
//! the tool wrapper takes, each standing answer beside the once-only one it
//! extends.

use gpui::{AnyElement, Context, Window, div, prelude::*};
use veyyon_desktop_model::ApprovalInteraction;
use veyyon_desktop_ui::{
	controls::ButtonVariant,
	theme::{ActiveTheme, TypeStyled, radius, space, text},
};

use super::{
	InteractionDock,
	card::{Choice, Control},
	row::body_max,
};
use crate::state::Answer;

/// The answers, the one the card leads with first.
pub(super) fn choices() -> Vec<Choice> {
	let answer = |approved, for_session| Answer::Approval { approved, for_session };
	vec![
		Choice::send("Allow once", ButtonVariant::Primary, answer(true, false), Control::Approve),
		Choice::send(
			"Always allow",
			ButtonVariant::Secondary,
			answer(true, true),
			Control::AlwaysAllow,
		),
		Choice::send("Deny", ButtonVariant::Secondary, answer(false, false), Control::Decline),
		Choice::send("Deny for session", ButtonVariant::Ghost, answer(false, true), Control::Decline),
	]
}

impl InteractionDock {
	/// The tool's name and what it would run, the call in a mono pane that
	/// scrolls past a share of the window.
	pub(super) fn render_approval(
		approval: &ApprovalInteraction,
		window: &Window,
		cx: &Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let detail = approval.detail.trim();
		div()
			.flex()
			.flex_col()
			.gap(space::S2)
			.child(
				div()
					.type_style(text::UI_MEDIUM)
					.text_color(palette.text.primary)
					.truncate()
					.child(format!("Run {}?", approval.tool_name)),
			)
			.when(!detail.is_empty(), |body| {
				body.child(
					div()
						.id("dock-approval-detail")
						.max_h(body_max(window))
						.overflow_y_scroll()
						.px(space::S2_5)
						.py(space::S2)
						.rounded(radius::LG)
						.bg(palette.code.bg)
						.type_style(text::MONO)
						.text_color(palette.text.secondary)
						.child(detail.to_owned()),
				)
			})
			.into_any_element()
	}
}
