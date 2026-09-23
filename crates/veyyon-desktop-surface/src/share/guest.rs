//! The share card a window draws while it is a guest in another's room (§5).

use veyyon_desktop_kit::{
	Badge, ButtonVariant, ColorRole, SpacingStep, TextRamp, TextWeight, TintRole, TokenSet,
};
use veyyon_desktop_model::{ShareGuestView, SurfaceId};
use veyyon_desktop_tokens::ShareSurfaceTokens;
use veyyon_gpui::{
	AnyElement, Context, InteractiveElement, IntoElement, ParentElement, Styled, div,
};

use super::{ShareState, gated_control, participants::participants_section};
use crate::{Intent, ShellView, controls::ControlStates};

/// The room this window is in, who else is in it, and the way out of it.
pub fn render_guest_view(
	state: &ShareState,
	guest: &ShareGuestView,
	controls: &ControlStates,
	geometry: &ShareSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let mut container = div()
		.id("share-guest-view")
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S3))
		.child(header_row(guest, tokens));

	if let Some(host_name) = &guest.host_name {
		container = container.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(format!("Hosted by {host_name}")),
		);
	}

	if let Some(view) = &state.share
		&& !view.participants.is_empty()
	{
		container = container.child(participants_section(&view.participants, geometry, tokens));
	}

	container
		.child(
			div()
				.flex()
				.items_center()
				.justify_end()
				.pt(tokens.spacing(SpacingStep::S2))
				.child(gated_control(
					"share-leave",
					"Leave share",
					SurfaceId::ShareLeaveButton,
					Intent::LeaveShare,
					ButtonVariant::Ghost,
					controls,
					tokens,
					cx,
				)),
		)
		.into_any_element()
}

/// The room, whether the socket is up, and what this guest may do in it.
fn header_row(guest: &ShareGuestView, tokens: &TokenSet) -> AnyElement {
	// A guest that lost the socket is still in the room: the card states the
	// reconnect rather than dropping to the off view, which would read as a
	// share that ended.
	let (connection_label, connection_tint) = if guest.connected {
		("connected", TintRole::Done)
	} else {
		("reconnecting…", TintRole::Working)
	};
	let (permission_label, permission_tint) = if guest.read_only {
		("read-only", TintRole::Plan)
	} else {
		("can write", TintRole::Done)
	};

	div()
		.flex()
		.items_center()
		.justify_between()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.flex()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S2))
				.child(
					div()
						.text_size(tokens.font_size(TextRamp::Body))
						.font_weight(tokens.font_weight(TextWeight::Semibold))
						.text_color(tokens.color(ColorRole::Foreground))
						.child(format!("Room {}", guest.room)),
				)
				.child(Badge::new(connection_label, connection_tint))
				.child(Badge::new(permission_label, permission_tint)),
		)
		.into_any_element()
}
