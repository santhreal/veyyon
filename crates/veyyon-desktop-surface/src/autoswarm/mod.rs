//! The autoswarm console card (§5.8).
//!
//! The console is the host's: every row, every note, every action and every
//! blocker arrives formatted from the console model the terminal draws from,
//! so a run logged in one front end is stated the same way in the other. The
//! card draws that projection and sends back a row, an action or a preset.

pub mod change;
pub mod ledger;
pub mod presets;
pub mod setup;

use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, InteractiveState, SpacingStep, TextRamp,
	TextWeight, TintRole, TokenSet,
};
use veyyon_desktop_model::{AutoswarmConsoleView, SessionId, SurfaceId};
use veyyon_desktop_tokens::AutoswarmSurfaceTokens;
use veyyon_gpui::{
	Context, FocusHandle, InteractiveElement, IntoElement, ParentElement, Styled, div, px,
};

use crate::{
	Intent, ShellView,
	controls::{ControlStates, availability_style},
	navigation::SurfaceRoute,
};

/// View model for the autoswarm console overlay card.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AutoswarmState {
	/// The console the host has open, or None until one arrives.
	pub console: Option<AutoswarmConsoleView>,
	pub route:   Option<SurfaceRoute>,
}

impl AutoswarmState {
	#[must_use]
	pub const fn new() -> Self {
		Self { console: None, route: Some(SurfaceRoute::Autoswarm) }
	}

	/// The session the open console belongs to, or None until one arrives.
	#[must_use]
	pub fn session(&self) -> Option<&str> {
		self
			.console
			.as_ref()
			.map(|console| console.session.as_str())
	}
}

/// Renders the autoswarm console card for the rail row `row`, which is what
/// every control of the card is keyed by.
pub fn autoswarm_surface(
	state: &AutoswarmState,
	row: &SessionId,
	editors: &setup::RowEditors,
	back: Option<SurfaceRoute>,
	focus: Option<&FocusHandle>,
	controls: &ControlStates,
	geometry: &AutoswarmSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut container = div()
		.id("autoswarm-card")
		.flex()
		.flex_col()
		.w_full()
		.h_full()
		.p(px(geometry.padding));

	if let Some(handle) = focus {
		container = container.track_focus(handle);
	}

	container = container.child(header(state, row, back, controls, tokens, cx));

	let Some(console) = state.console.as_ref() else {
		// The card is opened by the host, so a card with no console is the
		// gap between the command and the answer rather than a state to stay
		// in: it states what is awaited rather than an empty column.
		return container.child(
			div()
				.id("autoswarm-awaiting")
				.flex()
				.flex_col()
				.gap(tokens.spacing(SpacingStep::S2))
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child("The console has not arrived yet.")
				.child("Run /autoresearch to open it."),
		);
	};
	container
		.child(swarm_line(console, tokens))
		.child(setup::setup_section(console, row, editors, controls, geometry, tokens, cx))
		.child(ledger::ledger_section(console, geometry, tokens))
}

/// The card's title, the session it belongs to, the way back to the surface
/// it was descended from, and the control that closes it.
fn header(
	state: &AutoswarmState,
	row: &SessionId,
	back: Option<SurfaceRoute>,
	controls: &ControlStates,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let surface = SurfaceId::AutoswarmCloseButton(row.clone());
	let (opacity, cursor, allowed) = availability_style(&controls.availability(&surface), tokens);
	let mut close = Button::new("autoswarm-close", "Close")
		.size(ButtonSize::Small)
		.variant(ButtonVariant::Ghost);
	if allowed {
		close = close.on_click(cx.listener(|view, _, _, cx| {
			view.dispatch(Intent::CloseAutoswarmConsole, cx);
		}));
	} else {
		close = close.state(InteractiveState::Disabled);
	}

	let mut title_column = div().flex().flex_col().child(
		div()
			.text_size(tokens.font_size(TextRamp::Head))
			.line_height(tokens.line_height(TextRamp::Head))
			.font_weight(tokens.font_weight(TextWeight::Semibold))
			.text_color(tokens.color(ColorRole::Foreground))
			.child(SurfaceRoute::Autoswarm.title()),
	);

	if let Some(session) = state.session() {
		title_column = title_column.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(session.to_owned()),
		);
	}

	// The console is reached from the palette as well as from a command, and
	// a card opened over another surface states the way back to it. A card
	// with nothing above it states only that leaving closes it.
	let mut actions = div()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2));
	if let Some(route) = back {
		actions = actions.child(
			Button::new("autoswarm-back", "Back")
				.size(ButtonSize::Small)
				.variant(ButtonVariant::Ghost)
				.on_click(cx.listener(move |view, _, _, cx| {
					view.dispatch(Intent::Navigate(route), cx);
				})),
		);
	}
	actions = actions.child(div().opacity(opacity).cursor(cursor).child(close));

	div()
		.id("autoswarm-card-header")
		.flex()
		.items_center()
		.justify_between()
		.pb(tokens.spacing(SpacingStep::S4))
		.child(title_column)
		.child(actions)
}

/// What the swarm on this branch has measured so far, or the line a branch
/// with no swarm on it states in place of one.
fn swarm_line(console: &AutoswarmConsoleView, tokens: &TokenSet) -> impl IntoElement {
	let mut row = div()
		.id("autoswarm-swarm-line")
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S3))
		.pb(tokens.spacing(SpacingStep::S3))
		.text_size(tokens.font_size(TextRamp::Small))
		.line_height(tokens.line_height(TextRamp::Small));

	let Some(swarm) = console.swarm.as_ref() else {
		return row
			.text_color(tokens.color(ColorRole::Muted))
			.child("No swarm is recorded on this branch. Start one to log a run.");
	};

	row = row
		.text_color(tokens.color(ColorRole::Foreground))
		.child(swarm.goal.clone())
		.child(
			div()
				.text_color(tokens.color(ColorRole::Muted))
				.child(format!("{} logged", swarm.runs)),
		);

	if let Some(best) = swarm.best.as_ref() {
		row = row.child(
			div()
				.text_color(tokens.tint(TintRole::Done).ink)
				.child(format!("best {best}")),
		);
	}

	if let Some(running) = swarm.running.as_ref() {
		row = row.child(
			div()
				.text_color(tokens.tint(TintRole::Plan).ink)
				.child(format!("measuring {running}")),
		);
	}

	row
}
