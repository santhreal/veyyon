use serde::{Deserialize, Serialize};

/// Material specification for a single elevation level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ElevationLevel {
	pub index:          u8,
	pub role:           String,
	pub ground_role:    String,
	pub grain_enabled:  bool,
	pub grain_texture:  Option<String>,
	pub grain_opacity:  Option<f32>,
	pub blur_px:        f32,
	pub saturation:     Option<f32>,
	pub ground_opacity: Option<f32>,
	pub edge:           String,
	pub has_shadow:     bool,
	pub shadow_opacity: Option<f32>,
}

/// One shadow of the float model: how its offset, blur and inward pull follow
/// the rise of the surface, and the bounds each stays inside.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ShadowCurve {
	pub y_ratio:       f32,
	pub y_min_px:      f32,
	pub y_max_px:      f32,
	pub blur_ratio:    f32,
	pub blur_min_px:   f32,
	pub blur_max_px:   f32,
	pub spread_ratio:  f32,
	pub spread_min_px: f32,
	pub spread_max_px: f32,
	/// Fraction of the level's shadow opacity this shadow inks on a dark
	/// ground.
	pub dark_opacity:  f32,
	/// The same fraction on a light ground, where a cast shadow reads heavier.
	pub light_opacity: f32,
}

impl ShadowCurve {
	/// Vertical offset of this shadow at `rise_px`.
	#[must_use]
	pub fn offset_y(&self, rise_px: f32) -> f32 {
		(rise_px * self.y_ratio).clamp(self.y_min_px, self.y_max_px)
	}

	/// Blur radius of this shadow at `rise_px`.
	#[must_use]
	pub fn blur(&self, rise_px: f32) -> f32 {
		(rise_px * self.blur_ratio).clamp(self.blur_min_px, self.blur_max_px)
	}

	/// Spread of this shadow at `rise_px`, pulling the shape inward.
	#[must_use]
	pub fn spread(&self, rise_px: f32) -> f32 {
		-(rise_px * self.spread_ratio).clamp(self.spread_min_px, self.spread_max_px)
	}

	/// Opacity factor for a dark or a light ground.
	#[must_use]
	pub const fn opacity_factor(&self, is_dark: bool) -> f32 {
		if is_dark {
			self.dark_opacity
		} else {
			self.light_opacity
		}
	}
}

/// The shadow a float casts: a tight key shadow, a wide ambient one, and the
/// lit inner edge along its top.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FloatShadowModel {
	pub default_rise_px:       f32,
	pub key:                   ShadowCurve,
	pub ambient:               ShadowCurve,
	pub inner_highlight_y_px:  f32,
	pub inner_highlight_dark:  f32,
	pub inner_highlight_light: f32,
}

/// Resolved elevation and material specifications across all 5 levels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ElevationTokens {
	pub levels:          [ElevationLevel; 5],
	pub float_shadow:    FloatShadowModel,
	/// Backdrop blur a menu or a dialog frosts its backdrop with (§2.1), which
	/// is harder than the blur a resting float carries.
	pub overlay_blur_px: f32,
}

impl ElevationLevel {
	/// Ground opacity of a level that carries glass. A level with no backdrop
	/// blur states none, and its ground is its role colour at full opacity.
	#[must_use]
	pub fn ground_opacity(&self) -> f32 {
		self.ground_opacity.unwrap_or(1.0)
	}

	/// Backdrop saturation of a level that carries glass, and no change to
	/// saturation for a level that does not.
	#[must_use]
	pub fn saturation(&self) -> f32 {
		self.saturation.unwrap_or(1.0)
	}

	/// Grain opacity of a level that carries grain, and none for a level that
	/// does not.
	#[must_use]
	pub fn grain_opacity(&self) -> f32 {
		self.grain_opacity.unwrap_or(0.0)
	}

	/// Shadow opacity of a level that casts a shadow, and none for a level
	/// that does not.
	#[must_use]
	pub fn shadow_opacity(&self) -> f32 {
		self.shadow_opacity.unwrap_or(0.0)
	}
}

impl ElevationTokens {
	/// Returns the elevation level specification for the given index (0..=4).
	pub fn level(&self, index: usize) -> Option<&ElevationLevel> {
		self.levels.get(index)
	}

	/// Returns level 0: shell ground with grain texture.
	pub const fn shell_ground(&self) -> &ElevationLevel {
		&self.levels[0]
	}

	/// Returns level 1: queue rail.
	pub const fn queue_rail(&self) -> &ElevationLevel {
		&self.levels[1]
	}

	/// Returns level 2: canvas.
	pub const fn canvas(&self) -> &ElevationLevel {
		&self.levels[2]
	}

	/// Returns level 3: inset.
	pub const fn inset(&self) -> &ElevationLevel {
		&self.levels[3]
	}

	/// Returns level 4: glass float material.
	pub const fn float(&self) -> &ElevationLevel {
		&self.levels[4]
	}
}
