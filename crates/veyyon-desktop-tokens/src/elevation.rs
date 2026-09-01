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
	pub shadow_x:       Option<f32>,
	pub shadow_y:       Option<f32>,
	pub shadow_blur:    Option<f32>,
	pub shadow_spread:  Option<f32>,
	pub shadow_opacity: Option<f32>,
}

/// Resolved elevation and material specifications across all 5 levels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ElevationTokens {
	pub levels: [ElevationLevel; 5],
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
