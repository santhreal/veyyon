//! What a control primitive is measured in (§6.10).
//!
//! The kit draws buttons, switches, tooltips, popovers and editors against
//! these, so a height or a fade length is stated once in `controls.toml`
//! rather than at each primitive that draws it.

use serde::{Deserialize, Serialize};

/// Resolved measures every control primitive draws against.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ControlTokens {
	pub height_small_px:                 f32,
	pub height_medium_px:                f32,
	pub height_large_px:                 f32,
	pub toggle_track_width_px:           f32,
	pub scroll_fade_px:                  f32,
	pub tooltip_estimated_height_px:     f32,
	pub tooltip_estimated_advance_ratio: f32,
	pub popover_estimated_width_px:      f32,
	pub popover_estimated_height_px:     f32,
	pub editor_caret_width_px:           f32,
	pub editor_unmeasured_wrap_width_px: f32,
}
