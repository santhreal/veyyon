//! Rail footer pinned to the lower edge of the queue rail (§5.2).
//!
//! Renders a 36px footer with no ground and no edge, holding a single 16px
//! settings gear ghost icon button inset 8px at the bottom-left to open the
//! settings overlay.

use veyyon_desktop_kit::{
	TokenSet,
	controls::{IconButton, IconButtonVariant},
	icons::{IconName, IconSize},
};
use veyyon_desktop_tokens::QueueSurfaceTokens;
use veyyon_gpui::{ClickEvent, Context, IntoElement, ParentElement, Styled, div, px};

use crate::{Intent, ShellView, overlay::Overlay};

/// Renders the queue rail's bottom-pinned footer containing the settings gear.
pub fn queue_footer(
	geometry: &QueueSurfaceTokens,
	_tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	div()
		.flex_shrink_0()
		.h(px(geometry.footer_height_px))
		.px(px(geometry.footer_inset))
		.flex()
		.flex_row()
		.items_center()
		.child(
			IconButton::new(IconName::Settings)
				.id("queue-settings-gear")
				.variant(IconButtonVariant::Ghost)
				.size(IconSize::Size16)
				.on_click(cx.listener(|view, _event: &ClickEvent, _window, cx| {
					view.dispatch(Intent::OpenOverlay(Box::new(Overlay::Settings(Box::default()))));
					cx.notify();
				})),
		)
}
