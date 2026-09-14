use std::path::Path;

use veyyon_desktop_tokens::{
	ColorRole, MonoSizeStep, MotionRole, RadiusStep, SpacingStep, StrokeStep, TypeSizeStep,
	TypeWeightStep, load_from_dir,
};

#[test]
fn test_spacing_scale_ceiling() {
	// §6.1 Spacing: 14 steps, hard ceiling 16
	let all_spacing = SpacingStep::all();
	assert_eq!(all_spacing.len(), 14, "spacing scale must declare exactly 14 steps");
	assert!(all_spacing.len() <= 16, "spacing scale must not exceed ceiling of 16 (§6.1)");
}

#[test]
fn test_radii_scale_ceiling() {
	// §6.2 Radii: 6 values + none + full = 8 variants, hard ceiling 7 numeric steps
	// + full = 8
	let all_radii = RadiusStep::all();
	assert_eq!(all_radii.len(), 8, "radii scale must declare exactly 8 variants");
	assert!(all_radii.len() <= 8, "radii scale must not exceed ceiling of 8 (§6.2)");
}

#[test]
fn test_typography_ceilings() {
	// §6.3 Type: 6 sizes, 3 weights
	let all_sizes = TypeSizeStep::all();
	assert_eq!(all_sizes.len(), 6, "typographic sizes must declare exactly 6 variants");
	assert!(all_sizes.len() <= 6, "type sizes must not exceed ceiling of 6 (§6.3)");

	let all_weights = TypeWeightStep::all();
	assert_eq!(all_weights.len(), 3, "typographic weights must declare exactly 3 variants");
	assert!(all_weights.len() <= 3, "type weights must not exceed ceiling of 3 (§6.3)");

	let all_mono = MonoSizeStep::all();
	assert_eq!(all_mono.len(), 2, "mono sizes must declare exactly 2 variants");
}

#[test]
fn test_color_roles_ceiling() {
	// §6.4 Colour: semantic roles only, ceiling 40
	let all_roles = ColorRole::all();
	assert!(all_roles.len() <= 40, "color roles must not exceed ceiling of 40 (§6.4)");
	assert_eq!(all_roles.len(), 29, "color roles enum currently declares 29 roles");
}

#[test]
fn test_motion_roles_ceiling() {
	// §7.1 Motion: 7 roles
	let all_motion = MotionRole::all();
	assert_eq!(all_motion.len(), 7, "motion roles must declare exactly 7 roles");
}

#[test]
fn test_stroke_steps() {
	// §6.8 Stroke widths: 3 steps
	let all_strokes = StrokeStep::all();
	assert_eq!(all_strokes.len(), 3, "stroke steps must declare exactly 3 steps");
}

#[test]
fn test_surface_ink_ceilings_loaded() {
	// §6.6 Ink ceilings
	let tokens_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let tokens = load_from_dir(&tokens_dir).expect("load tokens");

	let c = &tokens.ceilings;
	assert_eq!(c.queue_card.edges, 2);
	assert_eq!(c.queue_card.distinct_gaps, 3);
	assert_eq!(c.queue_card.text_sizes, 3);
	assert_eq!(c.queue_card.interactive_elements, 3);

	assert_eq!(c.queue_line.edges, 1);
	assert_eq!(c.queue_line.distinct_gaps, 2);
	assert_eq!(c.queue_line.text_sizes, 2);
	assert_eq!(c.queue_line.interactive_elements, 2);

	assert_eq!(c.transcript_turn.edges, 1);
	assert_eq!(c.transcript_turn.distinct_gaps, 3);
	assert_eq!(c.transcript_turn.text_sizes, 3);
	assert_eq!(c.transcript_turn.interactive_elements, 4);

	assert_eq!(c.composer.edges, 3);
	assert_eq!(c.composer.distinct_gaps, 4);
	assert_eq!(c.composer.text_sizes, 3);
	assert_eq!(c.composer.interactive_elements, 8);

	assert_eq!(c.whole_window.edges, 16);
	assert_eq!(c.whole_window.distinct_gaps, 8);
	assert_eq!(c.whole_window.text_sizes, 6);
	assert_eq!(c.whole_window.interactive_elements, 105);
}
