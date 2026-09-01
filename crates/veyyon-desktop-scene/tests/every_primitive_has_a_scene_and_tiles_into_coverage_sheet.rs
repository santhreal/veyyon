//! WHY THIS SUITE EXISTS:
//! Section 6.7 mandates that every kit primitive owns a scene and that a
//! primitive with no scene does not ship. This suite asserts the completeness
//! coverage gate across all 41 primitive variants at runtime, verifies that
//! every primitive renders non-empty visual content (> 1 distinct pixel values)
//! on the GPU host, and generates the full kit coverage contact sheet.
//!
//! THE CLASS THIS CLOSES: Primitives shipping without a deterministic test
//! scene, primitives rendering completely empty/transparent frames, and
//! coverage gaps caused by introducing new unmapped primitive variants.
//!
//! WHAT IT DOES NOT CATCH: Fine-grained aesthetic balance or human subjective
//! taste, which requires visual inspection of the generated contact sheet PNG.

use std::{io::BufReader, path::PathBuf};

use strum::IntoEnumIterator;
use veyyon_desktop_kit::PrimitiveKind;
use veyyon_desktop_scene::{
	Appearance, RenderOptions, SceneRegistry, SheetGrid, distinct_pixel_values,
	generate_kit_coverage_sheet, headless_context, render_primitive_scene, write_png,
};

fn output_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/scene-frames")
}

const fn options() -> RenderOptions {
	RenderOptions {
		width:        320,
		height:       200,
		scale_factor: 2.0,
		appearance:   Appearance::Dark,
		seed:         0x5eed_cafe,
	}
}

#[test]
fn the_catalogue_covers_every_primitive_kind_variant() {
	let registry = SceneRegistry::new();
	let missing = registry.missing_scenes();
	assert!(
		missing.is_empty(),
		"catalogue must have zero missing scenes across all protocol and primitive variants, but \
		 found: {missing:?}"
	);

	for kind in PrimitiveKind::iter() {
		let required = veyyon_desktop_scene::RequiredState::Primitive(kind);
		let scene_name = required.scene_name();
		assert!(
			registry.get(&scene_name).is_some(),
			"primitive {kind:?} must have registered scene {scene_name} in the catalogue"
		);
	}
}

#[test]
fn removing_a_primitive_scene_turns_completeness_validation_red() {
	let mut registry = SceneRegistry::new();
	let target = "kit/button";
	let removed = registry.remove(target);
	assert!(removed.is_some(), "scene {target} must exist in registry");

	let missing = registry.missing_scenes();
	assert!(missing.contains(&target.to_string()), "missing scenes must include {target}");
	assert!(
		registry.validate_completeness().is_err(),
		"completeness validation must fail when a primitive scene is removed"
	);
}

#[test]
#[ignore = "requires a GPU with a Vulkan ICD; run with --ignored on a machine that has one"]
fn every_primitive_renders_distinct_pixels_on_headless_surface() {
	let mut cx = headless_context().expect("headless renderer is required");
	let opt = options();

	let mut uniform_failures = Vec::new();
	let mut rendered_count = 0usize;

	for kind in PrimitiveKind::iter() {
		let frame = render_primitive_scene(&mut cx, kind, &opt)
			.unwrap_or_else(|err| panic!("primitive {kind:?} failed to render: {err:?}"));

		rendered_count += 1;
		let distinct = distinct_pixel_values(&frame);
		if distinct <= 1 {
			uniform_failures.push(format!("{kind:?} (distinct pixels: {distinct})"));
		}
	}

	assert_eq!(rendered_count, 41, "expected exactly 41 primitives rendered, got {rendered_count}");
	assert!(
		uniform_failures.is_empty(),
		"The following primitive(s) rendered uniform/empty frames without drawing content:\n{}",
		uniform_failures.join("\n")
	);
}

#[test]
#[ignore = "requires a GPU with a Vulkan ICD; run with --ignored on a machine that has one"]
fn generate_and_save_kit_coverage_contact_sheet() {
	let mut cx = headless_context().expect("headless renderer is required");
	let opt = options();

	let grid = SheetGrid::new(6);
	let sheet = generate_kit_coverage_sheet(&mut cx, &opt, grid)
		.expect("kit coverage contact sheet tiles successfully");

	assert!(
		sheet.width() > 1000,
		"sheet width {} is unexpectedly small for 41 primitives",
		sheet.width()
	);
	assert!(
		sheet.height() > 1000,
		"sheet height {} is unexpectedly small for 41 primitives",
		sheet.height()
	);

	let distinct = distinct_pixel_values(&sheet);
	assert!(distinct > 1, "contact sheet produced a uniform image with no distinct pixels");

	let out_dir = output_dir();
	let out_path = out_dir.join("kit-coverage-contact-sheet.png");
	write_png(&sheet, &out_path).expect("contact sheet encodes as PNG");

	let meta = std::fs::metadata(&out_path).expect("PNG file was written to disk");
	assert!(meta.len() > 1024, "PNG file size is suspiciously small: {} bytes", meta.len());

	// Verify PNG decodes cleanly
	let file = std::fs::File::open(&out_path).expect("PNG file opens");
	let decoder = png::Decoder::new(BufReader::new(file));
	let reader = decoder.read_info().expect("PNG header decodes");
	let info = reader.info();

	assert_eq!(info.width, sheet.width());
	assert_eq!(info.height, sheet.height());

	println!(
		"Kit coverage contact sheet written to: {} ({}x{} px, {} bytes)",
		out_path.display(),
		sheet.width(),
		sheet.height(),
		meta.len()
	);
}

#[test]
#[ignore = "requires a GPU with a Vulkan ICD; run with --ignored on a machine that has one"]
fn rendered_primitive_scenes_use_bundled_dark_theme_colours() {
	let mut cx = headless_context().expect("headless renderer is required");
	let opt = options();

	let theme = veyyon_desktop_tokens::load_bundled_theme("dark").expect("load dark theme");
	let canvas_rgb = theme
		.roles
		.get(&veyyon_desktop_tokens::ColorRole::Canvas)
		.expect("canvas role");
	let expected_r = (canvas_rgb.r * 255.0).round() as u8;
	let expected_g = (canvas_rgb.g * 255.0).round() as u8;
	let expected_b = (canvas_rgb.b * 255.0).round() as u8;

	let frame =
		render_primitive_scene(&mut cx, PrimitiveKind::Button, &opt).expect("button scene renders");

	let mut found_canvas = false;
	for pixel in frame.pixels() {
		let dr = (pixel.r as i32 - expected_r as i32).abs();
		let dg = (pixel.g as i32 - expected_g as i32).abs();
		let db = (pixel.b as i32 - expected_b as i32).abs();
		if dr <= 2 && dg <= 2 && db <= 2 {
			found_canvas = true;
			break;
		}
	}

	assert!(
		found_canvas,
		"Rendered frame must contain ground Canvas pixel matching theme #16191f ({expected_r}, \
		 {expected_g}, {expected_b})"
	);
}
