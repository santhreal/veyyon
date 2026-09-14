use std::path::Path;

use veyyon_desktop_tokens::{
	DrawerPlacement, MonoSizeStep, RadiusStep, RightPanelMode, SpacingStep, StrokeStep,
	TypeSizeStep, TypeWeightStep, load_from_dir,
};

#[test]
fn test_load_shipped_tokens() {
	let tokens_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let tokens = load_from_dir(&tokens_dir).expect("shipped tokens should load and validate");

	// §6.1 Spacing scale
	assert_eq!(tokens.scale.spacing(SpacingStep::S0), 0.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S1), 2.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S2), 4.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S3), 6.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S4), 8.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S5), 10.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S6), 12.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S7), 14.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S8), 16.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S9), 20.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S10), 24.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S11), 32.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S12), 48.0);
	assert_eq!(tokens.scale.spacing(SpacingStep::S13), 64.0);

	// §6.2 Radii
	assert_eq!(tokens.scale.radius(RadiusStep::None), 0.0);
	assert_eq!(tokens.scale.radius(RadiusStep::Xs), 4.0);
	assert_eq!(tokens.scale.radius(RadiusStep::Sm), 6.0);
	assert_eq!(tokens.scale.radius(RadiusStep::Md), 8.0);
	assert_eq!(tokens.scale.radius(RadiusStep::Lg), 10.0);
	assert_eq!(tokens.scale.radius(RadiusStep::Xl), 14.0);
	assert_eq!(tokens.scale.radius(RadiusStep::Xxl), 18.0);
	assert_eq!(tokens.scale.radius(RadiusStep::Full), 9999.0);

	// §6.3 Typography
	assert_eq!(tokens.scale.type_size(TypeSizeStep::Micro).size, 11.0);
	assert_eq!(tokens.scale.type_size(TypeSizeStep::Micro).line_height, 16.0);
	assert_eq!(tokens.scale.type_size(TypeSizeStep::Body).size, 13.0);
	assert_eq!(tokens.scale.type_size(TypeSizeStep::Body).line_height, 18.0);
	assert_eq!(tokens.scale.type_size(TypeSizeStep::Read).size, 14.0);
	assert_eq!(tokens.scale.type_size(TypeSizeStep::Read).line_height, 22.0);
	assert_eq!(tokens.scale.type_size(TypeSizeStep::Head).size, 18.0);
	assert_eq!(tokens.scale.type_size(TypeSizeStep::Head).line_height, 24.0);
	assert_eq!(tokens.scale.type_size(TypeSizeStep::Lead).size, 26.0);
	assert_eq!(tokens.scale.type_size(TypeSizeStep::Lead).line_height, 32.0);

	assert_eq!(tokens.scale.type_weight(TypeWeightStep::Regular), 400);
	assert_eq!(tokens.scale.type_weight(TypeWeightStep::Medium), 500);
	assert_eq!(tokens.scale.type_weight(TypeWeightStep::Semibold), 600);

	assert_eq!(tokens.scale.mono_size(MonoSizeStep::Small).size, 11.0);
	assert_eq!(tokens.scale.mono_size(MonoSizeStep::Body).size, 12.0);

	// §6.8 Stroke
	assert_eq!(tokens.scale.stroke(StrokeStep::Hairline), 1.0);
	assert_eq!(tokens.scale.stroke(StrokeStep::Icon), 1.5);
	assert_eq!(tokens.scale.stroke(StrokeStep::Heavy), 2.0);

	// §6.5 Elevation & Material
	assert_eq!(tokens.elevation.levels.len(), 5);
	assert!(tokens.elevation.shell_ground().grain_enabled);
	assert_eq!(tokens.elevation.shell_ground().grain_texture.as_deref(), Some("blue_noise_128"));
	assert_eq!(tokens.elevation.shell_ground().grain_opacity, Some(0.025));
	assert_eq!(tokens.elevation.float().blur_px, 20.0);
	assert_eq!(tokens.elevation.float().saturation, Some(1.06));
	assert_eq!(tokens.elevation.float().ground_opacity, Some(0.82));
	assert!(tokens.elevation.float().has_shadow);

	// Surface geometry checks
	assert_eq!(tokens.surface.queue.width_default_px, 256.0);
	assert_eq!(tokens.surface.queue.width_min_px, 208.0);
	assert_eq!(tokens.surface.queue.card_px, 78.0);
	assert_eq!(tokens.surface.queue.line_px, 36.0);
	assert_eq!(tokens.surface.queue.content_inset, 8.0); // "s4" -> 8
	assert_eq!(tokens.surface.queue.row_inset, 10.0); // "s5" -> 10
	assert_eq!(tokens.surface.queue.footer_height_px, 36.0);
	assert_eq!(tokens.surface.queue.footer_inset, 8.0); // "s4" -> 8
	assert_eq!(tokens.surface.queue.gear_size_px, 16.0);
	assert_eq!(tokens.surface.queue.section_gap_above, 12.0); // "s6" -> 12
	assert_eq!(tokens.surface.queue.section_gap_below, 4.0); // "s2" -> 4

	assert_eq!(tokens.surface.transcript.column_width_px, 768.0);
	assert_eq!(tokens.surface.transcript.user_turn_padding, 12.0); // "s6" -> 12
	assert_eq!(tokens.surface.transcript.user_turn_radius_outer, 14.0); // "xl" -> 14
	assert_eq!(tokens.surface.transcript.user_turn_radius_trailing, 4.0); // "xs" -> 4

	assert_eq!(tokens.surface.composer.growth_cap_px, 200.0);
	assert_eq!(tokens.surface.composer.radius_outer, 18.0); // "xxl" -> 18
	assert_eq!(tokens.surface.composer.radius_inner, 14.0); // "xl" -> 14
	assert_eq!(tokens.surface.composer.padding_top, 14.0); // "s7" -> 14
	assert_eq!(tokens.surface.composer.padding_bottom, 12.0); // "s6" -> 12
	assert_eq!(tokens.surface.composer.padding_horizontal, 16.0); // "s8" -> 16

	// §5.7 Breakpoint modes
	assert_eq!(tokens.surface.breakpoints.wide.right_panel_mode, RightPanelMode::Inline {
		width_px: 540.0,
	});
	assert_eq!(tokens.surface.breakpoints.standard.right_panel_mode, RightPanelMode::Inline {
		width_px: 360.0,
	});
	assert_eq!(tokens.surface.breakpoints.compact.right_panel_mode, RightPanelMode::Overlay);
	assert_eq!(tokens.surface.breakpoints.collapsed.right_panel_mode, RightPanelMode::Overlay);

	// §5.7 row 4: the collapsed width is the one that overlays the drawer,
	// because at 800px the transcript has no 180px to give it.
	assert_eq!(
		[
			tokens.surface.breakpoints.wide.terminal_drawer_placement,
			tokens
				.surface
				.breakpoints
				.standard
				.terminal_drawer_placement,
			tokens.surface.breakpoints.compact.terminal_drawer_placement,
			tokens
				.surface
				.breakpoints
				.collapsed
				.terminal_drawer_placement,
		],
		[DrawerPlacement::Row, DrawerPlacement::Row, DrawerPlacement::Row, DrawerPlacement::Overlay,]
	);

	// Breakpoint resolution across viewport thresholds
	let bp = &tokens.surface.breakpoints;
	assert_eq!(bp.resolve(1920.0).min_width_px, 1440.0);
	assert_eq!(bp.resolve(1440.0).min_width_px, 1440.0);
	assert_eq!(bp.resolve(1439.0).min_width_px, 1180.0);
	assert_eq!(bp.resolve(1180.0).min_width_px, 1180.0);
	assert_eq!(bp.resolve(1179.0).min_width_px, 980.0);
	assert_eq!(bp.resolve(980.0).min_width_px, 980.0);
	assert_eq!(bp.resolve(979.0).min_width_px, 800.0);
	assert_eq!(bp.resolve(800.0).min_width_px, 800.0);
	assert_eq!(bp.resolve(799.0).min_width_px, 800.0);
	assert_eq!(bp.resolve(0.0).min_width_px, 800.0);
	assert_eq!(bp.resolve(-50.0).min_width_px, 800.0);
	assert_eq!(bp.resolve(f32::NAN).min_width_px, 800.0);
}
