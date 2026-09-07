//! Centered overlay placement and backdrop interaction.

use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

use crate::ShellView;

/// Renders a centered surface; its content is constructed before placement.
#[must_use]
pub fn overlay_scrim(
	content: impl IntoElement,
	panels: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	overlay_scrim_with_opacity(content, 1.0, panels, tokens, cx)
}

/// Renders a centered surface with modulated scrim backdrop opacity.
#[must_use]
pub fn overlay_scrim_with_opacity(
	content: impl IntoElement,
	opacity: f32,
	panels: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	div()
		.id("overlay-scrim")
		.absolute()
		.inset_0()
		.flex()
		.items_center()
		.justify_center()
		.opacity(opacity.clamp(0.0, 1.0))
		.backdrop_blur(px(panels.right_panel_overlay_scrim_blur_px))
		.bg(tokens.scrim())
		.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
			view.close_palette(cx);
		}))
		.child(
			div()
				.id("overlay-dialog-container")
				.on_click(|_event, _window, cx| cx.stop_propagation())
				.child(content),
		)
}
