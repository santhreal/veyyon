//! Deterministic scene construction, headless rasterization, and clutter
//! metric evaluation for the veyyon desktop front end.
//!
//! This crate provides the pure, renderer-free layout box tree representation,
//! raster frame models, and the six clutter metrics defined in §8.31 and §9.6.

pub mod contact_sheet;
pub mod fixtures;
pub mod frame;
pub mod headless;
pub mod layout;
pub mod layout_bridge;
pub mod metrics;
pub mod primitive_scenes;
pub mod registry;

pub use contact_sheet::{SheetCell, SheetGrid, tile};
pub use fixtures::{
	FixtureText, Reachability, block_reachability, content_block_fixture, entry_meta_fixture,
	role_reachability, session_badge_fixture, session_fixture, session_summary_fixture,
	transcript_entry_fixture, usage_totals_fixture,
};
pub use frame::{FrameError, PerceptualDiff, RgbaColor, RgbaFrame};
pub use headless::{
	Appearance, Captured, RenderError, RenderOptions, distinct_pixel_values, headless_context,
	render_view, render_view_captured, render_view_with_layout, write_png,
};
pub use layout::{
	BorderPaint, BoxBounds, BoxId, DividerAxis, LayoutBox, LayoutBoxSpec, LayoutBoxTree,
	LayoutBoxTreeBuilder, LayoutError, TextPaint,
};
pub use layout_bridge::layout_box_tree_from_quads;
pub use metrics::{
	Ceilings, ClutterMetrics, DENSEST_REGION_CEILING, MetricBreach, MetricReport, SurfaceClass,
	Verdict, ceilings, check, compute_alignment_residue, compute_distinct_gaps,
	compute_distinct_text_sizes, compute_edge_count, compute_element_density, compute_ink_ratio,
	compute_metrics, count_interactive, perceptual_diff,
};
pub use primitive_scenes::{
	PrimitiveSceneView, generate_kit_coverage_sheet, render_all_primitive_scenes, render_primitive,
	render_primitive_scene,
};
pub use registry::{
	ConnectionStateKind, FixtureSelection, GateVariant, PrimitiveKind, RequiredState, RowShape,
	Scene, SceneError, SceneRegistry, StateDescriptor, required_states,
};
