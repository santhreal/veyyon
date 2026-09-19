//! The ceiling declarations `ceilings.toml` states, which the scene suites
//! evaluate a rendered surface against.

use serde::{Deserialize, Serialize};

/// Hard ink, gap, type, and interactive element ceilings per surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SurfaceCeilings {
	pub edges:                usize,
	pub distinct_gaps:        usize,
	pub text_sizes:           usize,
	pub interactive_elements: usize,
}

/// Density region limits for interactive controls.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DensityRegionCeiling {
	pub sample_box_px:               f32,
	pub max_interactive_per_1000px2: f32,
}

/// All ceiling constraints loaded from ceilings.toml.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CeilingTokens {
	pub queue_card:             SurfaceCeilings,
	pub queue_line:             SurfaceCeilings,
	pub transcript_turn:        SurfaceCeilings,
	pub block_chrome:           SurfaceCeilings,
	pub composer:               SurfaceCeilings,
	pub right_panel_chrome:     SurfaceCeilings,
	pub terminal_drawer_chrome: SurfaceCeilings,
	pub whole_window:           SurfaceCeilings,
	pub density_region:         DensityRegionCeiling,
}
