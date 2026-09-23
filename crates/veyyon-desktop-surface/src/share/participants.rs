//! The roster of a share room, drawn the same way for the window hosting it
//! and for a window that joined it (§5).
//!
//! Both cards state the same thing — who is in the room and what each of them
//! may do — so the row, its height and its badges are defined once. Drawn
//! twice, the guest's roster sat at its own measures and the two cards
//! disagreed about how tall a participant is.

use veyyon_desktop_kit::{Badge, ColorRole, SpacingStep, TextRamp, TextWeight, TintRole, TokenSet};
use veyyon_desktop_model::ShareParticipantView;
use veyyon_desktop_tokens::ShareSurfaceTokens;
use veyyon_gpui::{
	AnyElement, ElementId, InteractiveElement, IntoElement, ParentElement,
	StatefulInteractiveElement, Styled, div, px,
};

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

/// The roster: its count, one row per participant, and the line a room with
/// nobody else in it states instead of an empty column.
#[must_use]
pub fn participants_section(
	participants: &[ShareParticipantView],
	geometry: &ShareSurfaceTokens,
	tokens: &TokenSet,
) -> AnyElement {
	let mut list = div()
		.id("share-participants-list")
		.flex()
		.flex_col()
		.gap(px(geometry.row_gap))
		.overflow_y_scroll()
		.flex_1();

	for participant in participants {
		list = list.child(participant_row(participant, geometry, tokens));
	}

	if participants.is_empty() {
		// A room with the host alone is the state a share spends its first
		// seconds in, and an empty column reads as a roster that failed to
		// arrive.
		list = list.child(
			div()
				.id("share-participants-empty")
				.px(tokens.spacing(SpacingStep::S3))
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child("No guests have joined yet."),
		);
	}

	div()
		.id("share-participants-section")
		.flex()
		.flex_col()
		.gap(px(geometry.row_gap))
		.flex_1()
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(format!("Participants ({})", participants.len())),
		)
		.child(list)
		.into_any_element()
}

/// One participant: the name, and the badges stating what that name may do.
fn participant_row(
	participant: &ShareParticipantView,
	geometry: &ShareSurfaceTokens,
	tokens: &TokenSet,
) -> impl IntoElement {
	let mut badges = div()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2));
	if participant.is_host {
		badges = badges.child(Badge::new("host", TintRole::Approve));
	}
	badges = badges
		.child(Badge::new(participant_write_label(participant), participant_write_tint(participant)));

	div()
		.id(ElementId::Name(format!("share-participant-{}", participant.id).into()))
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
						.child(participant.name.clone()),
				),
		)
		.child(badges)
}
