//! The band between the titlebar and the columns (§4.1).
//!
//! Three strips stack there: the connection banner, the freeze strip and the
//! notice strip. What that band takes off the window and what it draws are
//! one concern, because the two readings have to agree: a strip drawn without
//! being counted pushes the session surface down under it, and a strip
//! counted without being drawn leaves a band of ground where nothing is.

use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_model::SurfaceId;
use veyyon_gpui::{Context, Div, ParentElement};

use crate::{
	ShellView,
	shell::{
		connection::connection_banner,
		pause::{pause_strip, pause_strip_height},
		titlebar::{attention_strip, attention_strip_height},
	},
};

/// The height the titlebar and the strips under it take off the columns.
///
/// The banner is not counted, and a `Reconnecting` or `Fatal` phase draws one
/// above a live session: while either holds, this reads the columns as taller
/// than the band they are given, by the banner's own height. The banner's box
/// grows with a message that wraps, so counting it needs a measure the banner
/// draws at rather than one derived beside it.
#[must_use]
pub fn chrome_height(view: &ShellView) -> f32 {
	let tokens = &view.installed().set;
	let notice = if view.has_notice() {
		attention_strip_height(tokens)
	} else {
		0.0
	};
	let paused = if view.state().paused.is_some() {
		pause_strip_height(tokens)
	} else {
		0.0
	};
	view.installed().surface.shell.titlebar_height_px + notice + paused
}

/// The strips themselves, in the order they stack under the titlebar.
///
/// The freeze sits below the banner and above the notice: a window that is
/// not attached has no agents to have frozen, and a freeze outlasts anything
/// the notice strip is reporting.
pub fn chrome_strips(
	mut root: Div,
	view: &ShellView,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	if let Some(banner) = connection_banner(
		&view.state().connection,
		&view.state().controls,
		view.clock_ms(),
		tokens,
		cx,
	) {
		root = root.child(banner);
	}
	if let Some(elapsed) = view.state().paused.clone() {
		root = root.child(pause_strip(&elapsed, tokens, cx));
	}
	if let Some(notice) = view.notice() {
		root = root.child(attention_strip(notice, tokens));
	} else if let Some(err) = view.state().controls.error(&SurfaceId::GlobalTitlebarLine) {
		root = root.child(attention_strip(&err.message, tokens));
	}
	root
}
