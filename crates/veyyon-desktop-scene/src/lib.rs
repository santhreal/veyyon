//! Deterministic scene construction, headless rasterization, and clutter
//! metric evaluation for the veyyon desktop front end.
//!
//! This crate provides the pure, renderer-free layout box tree representation,
//! raster frame models, and the six clutter metrics defined in §8.31 and §9.6.

pub mod fixtures;
pub mod frame;
pub mod layout;
pub mod metrics;
pub mod registry;

pub use fixtures::{
	FixtureText, Reachability, block_reachability, content_block_fixture, entry_meta_fixture,
	role_reachability, session_badge_fixture, session_fixture, session_summary_fixture,
	transcript_entry_fixture, usage_totals_fixture,
};
pub use frame::{FrameError, PerceptualDiff, RgbaColor, RgbaFrame};
pub use layout::{
	BorderPaint, BoxBounds, BoxId, DividerAxis, LayoutBox, LayoutBoxSpec, LayoutBoxTree,
	LayoutBoxTreeBuilder, LayoutError, TextPaint,
};
pub use metrics::{
	Ceilings, ClutterMetrics, DENSEST_REGION_CEILING, MetricBreach, MetricReport, SurfaceClass,
	Verdict, ceilings, check, compute_alignment_residue, compute_distinct_gaps,
	compute_distinct_text_sizes, compute_edge_count, compute_element_density, compute_ink_ratio,
	compute_metrics, count_interactive, perceptual_diff,
};
pub use registry::{
	ConnectionStateKind, FixtureSelection, GateVariant, RequiredState, RowShape, Scene, SceneError,
	SceneRegistry, StateDescriptor, required_states,
};
