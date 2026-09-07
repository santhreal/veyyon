//! Focused command destinations using the existing domain body renderers.

use veyyon_desktop_kit::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet};
use veyyon_desktop_tokens::SettingsSurfaceTokens;
use veyyon_gpui::{
	Context, Div, FocusHandle, InteractiveElement, ParentElement, Stateful,
	StatefulInteractiveElement, Styled, div, px,
};

use super::{GeneralSettingsListState, SettingsPage, SettingsState, render_page_body};
use crate::{
	ShellView,
	controls::ControlStates,
	navigation::{SurfaceRoute, surface_header},
};

pub(super) fn focused_surface(
	state: &SettingsState,
	list_state: &GeneralSettingsListState,
	route: SurfaceRoute,
	focus: Option<&FocusHandle>,
	controls: &ControlStates,
	geometry: &SettingsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Stateful<Div> {
	let mut container = div().id("command-destination");
	if let Some(f) = focus {
		container = container.track_focus(f);
	}
	let container = container
		.key_context("CommandDestination")
		.w_full()
		.h_full()
		.min_h_0()
		.rounded(tokens.radius(RadiusStep::Xl))
		.bg(tokens.color(ColorRole::Float))
		.overflow_hidden()
		.flex()
		.flex_col()
		.p(tokens.spacing(SpacingStep::S6))
		.gap(tokens.spacing(SpacingStep::S4))
		.on_action(cx.listener(
			|view, _: &veyyon_desktop_kit::input::editor::actions::Escape, _window, cx| {
				view.back_surface(cx);
				cx.stop_propagation();
				cx.notify();
			},
		))
		.on_action(cx.listener(|view, _: &crate::keymap::actions::Dismiss, _window, cx| {
			view.back_surface(cx);
			cx.stop_propagation();
			cx.notify();
		}));
	let container = container.child(surface_header(route, tokens, cx)).child(
		div()
			.text_size(tokens.font_size(TextRamp::Small))
			.text_color(tokens.color(ColorRole::Muted))
			.child(state.page.description()),
	);
	let is_general = state.page == SettingsPage::General;
	let mut body_container = div()
		.id("command-destination-body")
		.flex_1()
		.min_h_0()
		.gap(px(geometry.row_gap));
	if is_general {
		body_container = body_container.overflow_hidden();
	} else {
		body_container = body_container.overflow_y_scroll();
	}
	container.child(
		body_container.child(render_page_body(state, list_state, controls, geometry, tokens, cx)),
	)
}
