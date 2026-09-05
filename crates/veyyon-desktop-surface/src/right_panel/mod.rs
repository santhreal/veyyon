//! The right panel (§5.6, §5.11).
//!
//! Owns the diff view, file view, and workspace tree tabs.

pub mod content;
pub mod diff_rows;
pub mod diff_view;
pub mod file_view;
pub mod tabs;
pub mod tree_view;

pub use content::{
	DiffFile, DiffRow, FileLine, FileView, HighlightSpan, PanelContent, PanelTab, TreeContent,
	TreeRowItem,
};
pub use diff_view::diff_view;
pub use file_view::{file_view, highlight_source};
pub use tabs::tab_strip;
pub use tree_view::tree_view;
use veyyon_desktop_kit::{ColorRole, TokenSet};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{Context, InteractiveElement, IntoElement, ParentElement, Styled, div, px};

use crate::{
	ShellView,
	intent::Intent,
	keymap::actions::{NextTab, PreviousTab, ToggleDiffMode},
};

/// Builds the right panel at the given width with active tab content.
pub fn right_panel(
	panel: &PanelContent,
	width: f32,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let active_content = match panel.active_tab {
		PanelTab::Diff => {
			diff_view(&panel.diff, panel.diff_mode, width, geometry, tokens, cx).into_any_element()
		},
		PanelTab::File => file_view(&panel.file, geometry, tokens, cx).into_any_element(),
		PanelTab::Tree => tree_view(&panel.tree, geometry, tokens, cx).into_any_element(),
	};

	let tab_count = panel.tabs.len();
	let current_tab_idx = panel
		.tabs
		.iter()
		.position(|&t| t == panel.active_tab)
		.unwrap_or(0);

	let prev_idx = if current_tab_idx == 0 {
		tab_count.saturating_sub(1)
	} else {
		current_tab_idx - 1
	};
	let next_idx = if tab_count == 0 {
		0
	} else {
		(current_tab_idx + 1) % tab_count
	};

	let next_diff_mode = match panel.diff_mode {
		veyyon_desktop_model::DiffMode::Unified => veyyon_desktop_model::DiffMode::Split,
		veyyon_desktop_model::DiffMode::Split => veyyon_desktop_model::DiffMode::Unified,
	};

	div()
		.id("right-panel")
		.on_action(cx.listener(move |view, _: &PreviousTab, _window, cx| {
			view.dispatch(Intent::SelectTab(prev_idx));
			cx.notify();
		}))
		.on_action(cx.listener(move |view, _: &NextTab, _window, cx| {
			view.dispatch(Intent::SelectTab(next_idx));
			cx.notify();
		}))
		.on_action(cx.listener(move |view, _: &ToggleDiffMode, _window, cx| {
			view.dispatch(Intent::SetDiffMode(next_diff_mode));
			cx.notify();
		}))
		.flex()
		.flex_col()
		.h_full()
		.w(px(width))
		.flex_shrink_0()
		.bg(tokens.color(ColorRole::Rail))
		// The leading edge is the container's: the split handle's line when
		// the panel is docked, the sheet's frame when it overlays (§5.6).
		.overflow_hidden()
		.child(tab_strip(panel, geometry, tokens, cx))
		.child(active_content)
}
