//! Overlay placement and backdrop interaction.

use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	ClickEvent, Context, InteractiveElement, IntoElement, ParentElement, Pixels,
	StatefulInteractiveElement, Styled, div, px,
};

use crate::ShellView;

/// Renders a surface over a scrim; its content is constructed before
/// placement.
///
/// `modal` is false for the frames a dismissed overlay is still fading out on.
/// A scrim that keeps occluding through the exit turns the whole window
/// pointer-dead for the length of the animation — the operator dismisses a
/// palette, presses a control, and the press reaches nothing — so the exiting
/// picture takes no pointer at all.
///
/// `top_inset` draws the surface that far below the scrim's top edge instead
/// of centring it. A surface whose height changes with what it holds is placed
/// this way: centring would move it under the operator between one keystroke
/// and the next.
#[must_use]
pub fn overlay_scrim(
	content: impl IntoElement,
	modal: bool,
	top_inset: Option<Pixels>,
	panels: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	// While open the scrim is modal: it swallows the pointer over the whole
	// window, so a press cannot reach a control behind the dialog, and a press
	// inside the dialog is not followed by one from an element underneath it
	// taking the focus back.
	let mut scrim = div()
		.id("overlay-scrim")
		.absolute()
		.inset_0()
		.flex()
		.justify_center()
		.backdrop_blur(px(panels.right_panel_overlay_scrim_blur_px))
		.bg(tokens.scrim());
	scrim = match top_inset {
		Some(inset) => scrim.items_start().pt(inset),
		None => scrim.items_center(),
	};
	if modal {
		scrim = scrim
			.occlude()
			.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
				view.close_palette(cx);
			}));
	}
	scrim.child(
		div()
			.id("overlay-dialog-container")
			.on_click(|_event, _window, cx| cx.stop_propagation())
			.child(content),
	)
}
