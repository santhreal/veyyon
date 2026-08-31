//! Change request summary and details presentation.

use gpui::{AnyElement, App, InteractiveElement, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::model::{ChangeRequest, ChangeRequestState, ReviewThread};
use veyyon_gui_kit::{
	theme::{Theme, space, weight},
	ui::{Badge, Icon, Tone, text},
};

pub fn render_change_request_card(
	cr: &ChangeRequest,
	threads: &[&ReviewThread],
	selected: bool,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	let cr_id_str = cr.id.as_str();

	let (state_tone, state_icon) = match cr.state {
		ChangeRequestState::Open => (Tone::Accent, Icon::Changed),
		ChangeRequestState::Submitted => (Tone::Ok, Icon::Check),
		ChangeRequestState::Approved => (Tone::Ok, Icon::Check),
		ChangeRequestState::Closed => (Tone::Muted, Icon::Close),
	};

	let total_threads = threads.len();
	let unresolved_threads = threads.iter().filter(|t| t.is_unresolved()).count();

	let mut header = div()
		.flex()
		.items_center()
		.justify_between()
		.gap(px(space::X8))
		.p(px(space::X8))
		.border_b_1()
		.border_color(theme.stroke);

	header = header
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::X6))
				.child(text::line(cr.title.clone()).font_weight(weight::STRONG))
				.child(
					Badge::new(cr.state.label())
						.icon(state_icon)
						.tone(state_tone),
				),
		)
		.child(
			div().flex().items_center().gap(px(space::X6)).child(
				Badge::new(if unresolved_threads == 0 {
					"All resolved".to_string()
				} else {
					format!("{unresolved_threads} unresolved")
				})
				.tone(if unresolved_threads == 0 {
					Tone::Ok
				} else {
					Tone::Warn
				}),
			),
		);

	let mut body = div().flex().flex_col().gap(px(space::X6)).p(px(space::X8));

	if let Some(desc) = &cr.description {
		body = body.child(text::note_wrapping(desc.clone(), &theme).text_color(theme.text_muted));
	}

	body = body.child(
		div()
			.flex()
			.items_center()
			.gap(px(space::X6))
			.child(text::meta(
				format!("{total_threads} review thread(s) in this change request"),
				&theme,
			)),
	);

	div()
		.id(format!("change-request-{}", cr_id_str))
		.flex()
		.flex_col()
		.rounded_lg()
		.border_1()
		.border_color(if selected { theme.ring } else { theme.stroke })
		.bg(theme.raised)
		.shadow_sm()
		.child(header)
		.child(body)
		.into_any_element()
}
