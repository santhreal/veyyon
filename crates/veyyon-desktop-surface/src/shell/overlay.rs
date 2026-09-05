//! Modal floating overlay placement and scrim rendering (§5.8, §5.9).

use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_tokens::{PanelsSurfaceTokens, SurfaceTokens};
use veyyon_gpui::{
	ClickEvent, Context, InteractiveElement, IntoElement, ParentElement, StatefulInteractiveElement,
	Styled, div, px,
};

use crate::{Intent, ShellView, controls::ControlStates, overlay::Overlay};

/// Renders the backdrop blur scrim and centered overlay dialog.
#[must_use]
pub fn overlay_scrim(
	overlay: &Overlay,
	controls: &ControlStates,
	panels: &PanelsSurfaceTokens,
	surface: &SurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let overlay_el = match overlay {
		Overlay::Palette(palette) => {
			crate::palette::palette_surface(palette, &surface.palette, &surface.queue, tokens, cx)
				.into_any_element()
		},
		Overlay::Settings(settings) => {
			crate::settings::settings_surface(settings, controls, &surface.settings, tokens, cx)
				.into_any_element()
		},
	};

	div()
		.id("overlay-scrim")
		.absolute()
		.inset_0()
		.flex()
		.items_center()
		.justify_center()
		.backdrop_blur(px(panels.right_panel_overlay_scrim_blur_px))
		.bg(tokens.scrim())
		.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
			view.dispatch(Intent::CloseOverlay);
			cx.notify();
		}))
		.child(
			div()
				.id("overlay-dialog-container")
				.on_click(cx.listener(|_view, _event: &ClickEvent, _window, _cx| {
					// Stop propagation inside dialog.
				}))
				.child(overlay_el),
		)
}
