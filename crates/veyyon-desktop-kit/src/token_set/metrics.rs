//! Measures and strengths resolved once for the primitives that draw them.
//!
//! A control reads a dimming ratio and a tool view reads its row measures from
//! the installed token set, so neither restates a value the token files
//! already state, which is how two controls drift apart for one state.

use veyyon_gpui::Pixels;

/// Interactive strength an availability state renders at, authored in
/// `surface/shell.toml` under `[gate]` (§4.3).
///
/// These are resolved once at construction so a primitive reads a strength
/// from the installed token set rather than restating the ratio at each
/// control, which is how two controls drift to different dimming for the same
/// state.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GateStrengths {
	pub pending:     f32,
	pub unavailable: f32,
}

/// Measures a tool view draws its dense rows against, authored in
/// `surface/transcript.toml` under `[tool_view]`.
///
/// A tool view renders inside the transcript and reaches no surface token of
/// its own, so the four measures it needs are resolved once here beside the
/// gate strengths.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ToolViewMetrics {
	/// Vertical padding of a code, diff or status line.
	pub row_pad_y:          Pixels,
	/// Width of the diff line-number gutter.
	pub line_number_gutter: Pixels,
	/// Indent a notice body takes under the icon that headlines it.
	pub notice_body_indent: Pixels,
	/// Width a result summary beside a call header stops at.
	pub summary_max_width:  Pixels,
}
