//! Inactive and transitional share card views (§5).

use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, InteractiveState, Row, SpacingStep, TextField,
	TextRamp, TextWeight, TokenSet, input::Editor,
};
use veyyon_desktop_model::{SharePhase, SurfaceId};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Entity, InteractiveElement, IntoElement, ParentElement, Styled,
	div,
};

use super::{ShareState, gated_control};
use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
};

/// Whether this state offers controls to start sharing.
#[must_use]
pub fn offers_start(state: &ShareState) -> bool {
	state.phase() == SharePhase::Off && has_relay(state)
}

/// Whether this state offers controls to stop sharing.
#[must_use]
pub fn offers_stop(state: &ShareState) -> bool {
	state.phase() == SharePhase::Hosting
}

/// Whether this state offers controls to join a share.
#[must_use]
pub fn offers_join(state: &ShareState) -> bool {
	state.phase() == SharePhase::Off
}

/// Whether this state offers controls to leave a share.
#[must_use]
pub fn offers_leave(state: &ShareState) -> bool {
	state.phase() == SharePhase::Joined
}

/// Whether a relay URL is configured.
#[must_use]
pub fn has_relay(state: &ShareState) -> bool {
	state.relay_url().is_some_and(|url| !url.trim().is_empty())
}

/// Renders the inactive share card view.
pub fn render_off_view(
	state: &ShareState,
	link_editor: Option<Entity<Editor>>,
	controls: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	// A join link carries the relay it was minted on, so joining is offered
	// whether or not this window has one configured to host on.
	let join = join_section(link_editor, controls, tokens, cx);
	if !has_relay(state) {
		return div()
			.id("share-no-relay")
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S2))
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Body))
					.line_height(tokens.line_height(TextRamp::Body))
					.text_color(tokens.color(ColorRole::Foreground))
					.child("No relay configured."),
			)
			.child(
				div()
					.text_size(tokens.font_size(TextRamp::Small))
					.line_height(tokens.line_height(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.child("Configure collab.relayUrl in settings to enable sharing."),
			)
			.child(join)
			.into_any_element();
	}

	let container = div()
		.id("share-off-controls")
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S3))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.text_color(tokens.color(ColorRole::Foreground))
				.child("Share this session with guests over the configured relay."),
		)
		.child(
			div()
				.flex()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S3))
				.child(gated_control(
					"share-start",
					"Start sharing",
					SurfaceId::ShareStartButton,
					Intent::StartShare { read_only: false },
					ButtonVariant::Primary,
					controls,
					tokens,
					cx,
				))
				.child(gated_control(
					"share-start-readonly",
					"Start sharing (read-only)",
					SurfaceId::ShareStartReadOnlyButton,
					Intent::StartShare { read_only: true },
					ButtonVariant::Ghost,
					controls,
					tokens,
					cx,
				)),
		);

	container.child(join).into_any_element()
}

/// The link field and the control that joins the room it names.
fn join_section(
	link_editor: Option<Entity<Editor>>,
	controls: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> AnyElement {
	let availability = controls.availability(&SurfaceId::ShareJoinButton);
	let (_, _, allowed) = availability_style(&availability, tokens);
	// An empty field would send a join the host refuses, so the control rests
	// until the field holds something to join.
	let has_link = link_editor
		.as_ref()
		.is_some_and(|editor| !editor.read(cx).text().trim().is_empty());
	let mut join_btn = Button::new("share-join-btn", "Join").size(ButtonSize::Small);
	if allowed && has_link {
		join_btn = join_btn.on_click(cx.listener(|view, _e: &ClickEvent, _w, cx| {
			view.submit_share_join(cx);
		}));
	} else {
		join_btn = join_btn.state(InteractiveState::Disabled);
	}

	let control: AnyElement = match link_editor {
		Some(editor) => Row::new(SpacingStep::S2)
			.child(TextField::new("share-link-input", editor))
			.child(join_btn)
			.into_any_element(),
		None => join_btn.into_any_element(),
	};
	div()
		.id("share-join-section")
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S2))
		.pt(tokens.spacing(SpacingStep::S3))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child("Join a share"),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child("Connect to a session another veyyon hosts with its link."),
		)
		.child(control)
		.into_any_element()
}

/// Renders in-progress phase transitions (starting and stopping).
pub fn render_transition_view(phase: SharePhase, tokens: &TokenSet) -> AnyElement {
	let message = match phase {
		SharePhase::Starting => "Starting share…",
		SharePhase::Stopping => "Stopping share…",
		SharePhase::Joining => "Joining share…",
		SharePhase::Leaving => "Leaving share…",
		_ => "Transitioning…",
	};

	div()
		.id("share-transition")
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(message),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child("Waiting for the relay to answer."),
		)
		.into_any_element()
}

/// Renders unknown phase words without claiming anything.
pub fn render_unknown_view(state: &ShareState, tokens: &TokenSet) -> AnyElement {
	let raw = state.share.as_ref().map_or("unknown", |s| s.state.as_str());

	div()
		.id("share-unknown")
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(format!("Relay state: {raw}")),
		)
		.into_any_element()
}
