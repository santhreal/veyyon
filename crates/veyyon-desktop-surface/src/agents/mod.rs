//! Agent dashboard floating overlay (§5).
//!
//! Renders the live roster and agent-to-agent IRC comms stream.

pub mod comms;
pub mod live;

use veyyon_desktop_kit::{
	Button, ButtonSize, ButtonVariant, ColorRole, Segmented, SpacingStep, TextRamp, TextWeight,
	TokenSet,
};
use veyyon_desktop_model::{AgentMessageView, AgentView};
use veyyon_desktop_tokens::AgentsSurfaceTokens;
use veyyon_gpui::{
	Context, ElementId, FocusHandle, InteractiveElement, IntoElement, ParentElement, Styled, div, px,
};

use crate::{Intent, ShellView, controls::ControlStates, navigation::SurfaceRoute};

/// Active view tab in the agent dashboard card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AgentViewTab {
	#[default]
	Live,
	Comms,
}

/// View model for the agent dashboard overlay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentsState {
	pub active_tab:          AgentViewTab,
	pub agents:              Vec<AgentView>,
	pub agent_comms:         Vec<AgentMessageView>,
	pub selected_agent:      Option<usize>,
	pub pending_termination: Option<String>,
	pub route:               Option<SurfaceRoute>,
}

impl Default for AgentsState {
	fn default() -> Self {
		Self::new()
	}
}

impl AgentsState {
	#[must_use]
	pub const fn new() -> Self {
		Self {
			active_tab:          AgentViewTab::Live,
			agents:              Vec::new(),
			agent_comms:         Vec::new(),
			selected_agent:      None,
			pending_termination: None,
			route:               Some(SurfaceRoute::Agents),
		}
	}
}

/// Renders the agent dashboard card surface.
pub fn agents_surface(
	state: &AgentsState,
	back: Option<SurfaceRoute>,
	focus: Option<&FocusHandle>,
	controls: &ControlStates,
	now_ms: u64,
	geometry: &AgentsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let mut container = div()
		.id("agents-dashboard")
		.flex()
		.flex_col()
		.w_full()
		.h_full()
		.p(px(geometry.padding));

	if let Some(f) = focus {
		container = container.track_focus(f);
	}

	let title = SurfaceRoute::Agents.title();

	let mut header = div()
		.id("agents-dashboard-header")
		.flex()
		.items_center()
		.justify_between()
		.pb(tokens.spacing(SpacingStep::S4))
		.child(
			div()
				.flex()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S3))
				.child(
					div()
						.text_size(tokens.font_size(TextRamp::Head))
						.line_height(tokens.line_height(TextRamp::Head))
						.font_weight(tokens.font_weight(TextWeight::Semibold))
						.text_color(tokens.color(ColorRole::Foreground))
						.child(title),
				),
		);

	// A choice between two views is a segmented control (§6.10): the chosen
	// view is foreground ink on a hairline ground, and the counts state how
	// much each view holds before it is opened.
	let entity = cx.entity();
	let tabs = Segmented::new(
		ElementId::Name("agents-tabs".into()),
		[format!("Live ({})", state.agents.len()), format!("Comms ({})", state.agent_comms.len())],
		usize::from(state.active_tab == AgentViewTab::Comms),
	)
	.size(ButtonSize::Small)
	.on_change(move |index, _window, app| {
		let tab = if index == 0 {
			AgentViewTab::Live
		} else {
			AgentViewTab::Comms
		};
		let () = entity.update(app, |view, cx| view.dispatch(Intent::SetAgentsTab(tab), cx));
	});

	let mut actions = div()
		.flex()
		.items_center()
		.gap(tokens.spacing(SpacingStep::S2));
	if let Some(back_route) = back {
		actions = actions.child(
			Button::new("agents-back", "Back")
				.size(ButtonSize::Small)
				.variant(ButtonVariant::Ghost)
				.on_click(cx.listener(move |view, _, _, cx| {
					view.dispatch(Intent::Navigate(back_route), cx);
				})),
		);
	}
	actions = actions.child(
		Button::new("agents-close", "Close")
			.size(ButtonSize::Small)
			.variant(ButtonVariant::Ghost)
			.on_click(cx.listener(|view, _, _, cx| {
				view.dispatch(Intent::CloseOverlay, cx);
			})),
	);

	header = header.child(tabs).child(actions);
	container = container.child(header);

	let body = match state.active_tab {
		AgentViewTab::Live => live::render_live_view(state, controls, geometry, tokens, cx),
		AgentViewTab::Comms => comms::render_comms_view(state, now_ms, geometry, tokens),
	};

	container.child(body)
}
