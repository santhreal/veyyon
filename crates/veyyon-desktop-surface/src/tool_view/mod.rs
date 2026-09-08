//! Pure native GPUI renderer for canonical `ToolView` models (§contracts/view).
//!
//! Renders all five canonical `ToolView` representations (`statusRow`,
//! `textBlock`, `headedBlock`, `framedBlock`, `notice`) into native GPUI
//! elements without terminal emulation components or ANSI escape leakage.

use std::rc::Rc;

use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_model::tool_view::ToolView;
use veyyon_gpui::{App, Div, Window};

pub mod code;
pub mod diff;
pub mod disclosure;
pub mod fit;
pub mod framed_block;
pub mod headed_block;
pub mod notice;
pub mod row;
pub mod sanitize;
pub mod section;
pub mod status_row;
pub mod text_block;
pub mod theme;
pub mod tree;

pub use code::render_code_lines;
pub use diff::render_diff_lines;
pub use disclosure::render_disclosure;
pub use fit::FitsTheRow;
pub use framed_block::render_framed_block;
pub use headed_block::render_headed_block;
pub use notice::render_notice;
pub use row::render_tool_view_row;
pub use sanitize::sanitize_control_sequences;
pub use section::render_section;
pub use status_row::render_status_row;
pub use text_block::{render_line, render_span, render_text_block};
pub use tree::render_tree_lines;

/// An actionable navigation target named by a `ToolView` element (URL or file).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum ToolViewTarget {
	/// Web URL hyperlink target.
	Url(String),
	/// Filesystem path with optional 1-based line number.
	File { path: String, line: Option<usize> },
}

/// Callback for user disclosure gestures (expanding hidden lines/items).
pub type DisclosureCallback = Rc<dyn Fn(&mut Window, &mut App)>;

/// Callback for navigating to actionable URL or file targets.
pub type TargetCallback = Rc<dyn Fn(ToolViewTarget, &mut Window, &mut App)>;

/// Registered interaction callbacks for `ToolView` rendering.
#[derive(Clone, Default)]
pub struct ToolViewCallbacks {
	/// Callback invoked when a user clicks a revealable hidden-count badge.
	pub on_disclose: Option<DisclosureCallback>,
	/// Callback invoked when a user clicks an actionable URL or file target.
	pub on_target:   Option<TargetCallback>,
}

impl ToolViewCallbacks {
	/// Creates an empty set of interaction callbacks.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Registers a callback for disclosure gestures.
	#[must_use]
	pub fn on_disclose(mut self, callback: impl Fn(&mut Window, &mut App) + 'static) -> Self {
		self.on_disclose = Some(Rc::new(callback));
		self
	}

	/// Registers a callback for actionable targets.
	#[must_use]
	pub fn on_target(
		mut self,
		callback: impl Fn(ToolViewTarget, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_target = Some(Rc::new(callback));
		self
	}
}

/// Renders a borrowed canonical `ToolView` into a native GPUI element tree.
///
/// # Arguments
/// * `view` - Borrowed canonical `ToolView` DTO.
/// * `tokens` - Resolved visual design tokens.
/// * `row_budget` - Optional maximum row ceiling for viewport bounds.
/// * `callbacks` - Interaction callbacks for disclosure and target navigation.
#[must_use]
pub fn render_tool_view(
	view: &ToolView,
	tokens: &TokenSet,
	row_budget: Option<usize>,
	callbacks: &ToolViewCallbacks,
) -> Div {
	match view {
		ToolView::StatusRow(row) => render_status_row(row, tokens, callbacks),
		ToolView::TextBlock(text) => render_text_block(text, tokens, row_budget, callbacks),
		ToolView::HeadedBlock(headed) => render_headed_block(headed, tokens, row_budget, callbacks),
		ToolView::FramedBlock(framed) => render_framed_block(framed, tokens, row_budget, callbacks),
		ToolView::Notice(notice) => render_notice(notice, tokens, callbacks),
	}
}
