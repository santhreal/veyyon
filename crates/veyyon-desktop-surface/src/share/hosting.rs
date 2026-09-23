//! Active session hosting share card views (§5).

use veyyon_desktop_kit::{
	Badge, Button, ButtonSize, ButtonVariant, ColorRole, SpacingStep, TextRamp, TextWeight,
	TintRole, TokenSet,
};
use veyyon_desktop_model::{ShareParticipantView, ShareView, SurfaceId};
use veyyon_desktop_tokens::ShareSurfaceTokens;
use veyyon_gpui::{
	AnyElement, Context, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

use super::{ShareState, gated_control};
use crate::{Intent, ShellView, controls::ControlStates};

/// What a participant row states about write permissions.
#[must_use]
pub const fn participant_write_label(participant: &ShareParticipantView) -> &'static str {
	if participant.can_write {
		"can write"
	} else {
		"read-only"
	}
}

/// The tint for a participant's write permission badge.
#[must_use]
pub const fn participant_write_tint(participant: &ShareParticipantView) -> TintRole {
	if participant.can_write {
		TintRole::Done
	} else {
		TintRole::Plan
	}
}

/// Every link the room offers, in the order the card states them.
///
/// A share mints four addresses and a read-only one mints two, so the rows are
/// whichever of them the host sent. Holding the table here rather than inside
/// the render keeps it answerable: a link that reaches the window and is drawn
/// nowhere is a room a guest cannot open.
#[must_use]
pub fn link_rows(view: &ShareView) -> Vec<(&'static str, &'static str, &str)> {
	let candidates: [(&'static str, &'static str, Option<&str>); 4] = [
		("rw", "Share link", view.link.as_deref()),
		("rw-web", "Browser link", view.web_link.as_deref()),
		("ro", "Read-only link", view.view_link.as_deref()),
		("ro-web", "Read-only browser link", view.web_view_link.as_deref()),
	];
	candidates
		.into_iter()
		.filter_map(|(key, label, link)| link.map(|link| (key, label, link)))
		.collect()
}

/// One link the room offers, with the control that copies it.
///
/// Every link a share mints is a line of the same shape — a label, the address
/// under it, and a copy control at the end — so the row is built once and the
/// card states all four (§5): the two a veyyon opens and the two a browser
/// does, each in a writable and a read-only spelling.
fn link_row(
	key: &'static str,
	label: &'static str,
	link: String,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let copied = link.clone();
	div()
		.id(ElementId::Name(format!("share-link-row-{key}").into()))
		.flex()
		.items_center()
		.justify_between()
		.p(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.flex()
				.flex_col()
				.gap(tokens.spacing(SpacingStep::S1))
				.child(
					div()
						.text_size(tokens.font_size(TextRamp::Small))
						.font_weight(tokens.font_weight(TextWeight::Medium))
						.text_color(tokens.color(ColorRole::Foreground))
						.child(label),
				)
				.child(
					div()
						.text_size(tokens.font_size(TextRamp::Small))
						.line_height(tokens.line_height(TextRamp::Small))
						.text_color(tokens.color(ColorRole::Muted))
						.child(link),
				),
		)
		.child(
			Button::new(ElementId::Name(format!("share-copy-{key}").into()), "Copy")
				.size(ButtonSize::Small)
				.variant(ButtonVariant::Ghost)
				.on_click(cx.listener(move |view, _, _, cx| {
					view.dispatch(Intent::CopyText(copied.clone()), cx);
				})),
		)
}

/// Renders the active hosting share view.
pub fn render_hosting_view(
	state: &ShareState,
	controls: &ControlStates,
	geometry: &ShareSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let mut container = div()
		.id("share-hosting-body")
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S4))
		.flex_1();

	let share = state.share.as_ref();
	let mut links_col = div()
		.id("share-links")
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S2));
	for (key, label, link) in share.map(link_rows).unwrap_or_default() {
		links_col = links_col.child(link_row(key, label, link.to_owned(), tokens, cx));
	}

	container = container.child(links_col);

	let participants = share.map_or(&[][..], |s| s.participants.as_slice());

	let mut part_section = div()
		.id("share-participants-section")
		.flex()
		.flex_col()
		.gap(px(geometry.row_gap))
		.flex_1();

	part_section = part_section.child(
		div()
			.text_size(tokens.font_size(TextRamp::Small))
			.font_weight(tokens.font_weight(TextWeight::Medium))
			.text_color(tokens.color(ColorRole::Foreground))
			.child(format!("Participants ({})", participants.len())),
	);

	let mut part_list = div()
		.id("share-participants-list")
		.flex()
		.flex_col()
		.gap(px(geometry.row_gap))
		.overflow_y_scroll()
		.flex_1();

	for p in participants {
		let write_label = participant_write_label(p);
		let write_tint = participant_write_tint(p);

		let mut row = div()
			.id(ElementId::Name(format!("share-participant-{}", p.id).into()))
			.h(px(geometry.row_height_px))
			.flex()
			.items_center()
			.justify_between()
			.px(tokens.spacing(SpacingStep::S3))
			.child(
				div()
					.flex()
					.items_center()
					.gap(tokens.spacing(SpacingStep::S2))
					.child(
						div()
							.text_size(tokens.font_size(TextRamp::Body))
							.font_weight(tokens.font_weight(TextWeight::Medium))
							.text_color(tokens.color(ColorRole::Foreground))
							.child(p.name.clone()),
					),
			);

		let mut badges = div()
			.flex()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S2));

		if p.is_host {
			badges = badges.child(Badge::new("host", TintRole::Approve));
		}
		badges = badges.child(Badge::new(write_label, write_tint));

		row = row.child(badges);
		part_list = part_list.child(row);
	}

	if participants.is_empty() {
		// A room with the host alone is the state a share spends its first
		// seconds in, and an empty column reads as a roster that failed to
		// arrive.
		part_list = part_list.child(
			div()
				.id("share-participants-empty")
				.px(tokens.spacing(SpacingStep::S3))
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child("No guests have joined yet."),
		);
	}

	part_section = part_section.child(part_list);
	container = container.child(part_section);

	let footer = div()
		.id("share-footer")
		.flex()
		.items_center()
		.justify_end()
		.gap(tokens.spacing(SpacingStep::S2))
		.pt(tokens.spacing(SpacingStep::S3))
		.child(gated_control(
			"share-refresh",
			"Refresh",
			SurfaceId::ShareRefreshButton,
			Intent::RefreshShare,
			ButtonVariant::Ghost,
			controls,
			tokens,
			cx,
		))
		.child(gated_control(
			"share-stop",
			"Stop sharing",
			SurfaceId::ShareStopButton,
			Intent::StopShare,
			ButtonVariant::Danger,
			controls,
			tokens,
			cx,
		));

	container = container.child(footer);
	container.into_any_element()
}
