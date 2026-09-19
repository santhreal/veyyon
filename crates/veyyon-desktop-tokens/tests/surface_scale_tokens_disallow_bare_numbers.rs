//! WHY: Surface tokens must reference declared scales by name rather than
//! repeating bare numbers. A raw number in a scale-resolved field creates a
//! second source of truth and bypasses token discipline.
//!
//! CLASS CLOSED: Any scale-resolved field in any surface file carrying a bare
//! numeric literal instead of a scale step reference name. The surface files
//! and their scale-resolved fields are enumerated from the filesystem at run
//! time, so newly added surface files and tokens arrive covered automatically.
//!
//! NOT CAUGHT: Genuine layout dimensions (panel widths, window sizes, caps)
//! that the scale does not name, which remain literal by design.

use std::{
	fs,
	path::{Path, PathBuf},
};

use toml::Value;
use veyyon_desktop_tokens::{
	RadiusStep, SpacingStep, StrokeStep, TokenError, TypeSizeStep, load_from_dir,
};
use veyyon_test_scratch::{TempTree, scratch_dir};

fn shipped_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tokens")
}

fn surface_files() -> Vec<PathBuf> {
	let surface_dir = shipped_dir().join("surface");
	let mut files = Vec::new();
	for entry in fs::read_dir(&surface_dir).expect("read surface dir") {
		let path = entry.expect("dir entry").path();
		if path.extension().is_some_and(|e| e == "toml") {
			files.push(path);
		}
	}
	files.sort();
	assert!(files.len() >= 9, "expected at least 9 surface token files, found {}", files.len());
	files
}

fn copy_shipped(label: &str) -> (TempTree, PathBuf) {
	let tree = scratch_dir(label);
	let dir = tree.path().to_path_buf();
	fs::create_dir_all(dir.join("surface")).expect("mkdir surface");

	let shipped = shipped_dir();
	for entry in fs::read_dir(&shipped).expect("read shipped") {
		let path = entry.expect("shipped entry").path();
		if path.is_file() {
			let name = path.file_name().expect("file name");
			fs::copy(&path, dir.join(name)).expect("copy top-level token file");
		}
	}
	for entry in fs::read_dir(shipped.join("surface")).expect("read surface") {
		let path = entry.expect("surface entry").path();
		if path.is_file() {
			let name = path.file_name().expect("file name");
			fs::copy(&path, dir.join("surface").join(name)).expect("copy surface file");
		}
	}
	(tree, dir)
}

fn is_scale_token_string(s: &str) -> bool {
	SpacingStep::from_token(s).is_some()
		|| RadiusStep::from_token(s).is_some()
		|| StrokeStep::from_token(s).is_some()
		|| TypeSizeStep::from_token(s).is_some()
}

fn collect_scale_field_paths(
	table: &toml::map::Map<String, Value>,
	prefix: &str,
	out: &mut Vec<(String, String)>,
) {
	for (key, value) in table {
		let path = if prefix.is_empty() {
			key.clone()
		} else {
			format!("{prefix}.{key}")
		};
		match value {
			Value::Table(inner) => collect_scale_field_paths(inner, &path, out),
			Value::String(s) if is_scale_token_string(s) => {
				out.push((path, key.clone()));
			},
			_ => {},
		}
	}
}

fn parent_mut<'a>(
	root: &'a mut toml::map::Map<String, Value>,
	path: &str,
) -> (&'a mut toml::map::Map<String, Value>, String) {
	let mut segments: Vec<&str> = path.split('.').collect();
	let last = segments.pop().expect("non-empty path").to_string();
	let Some(first) = segments.first() else {
		return (root, last);
	};
	let mut value: &mut Value = root.get_mut(*first).expect("first segment exists");
	for segment in &segments[1..] {
		value = match value {
			Value::Table(table) => table.get_mut(*segment).expect("segment exists"),
			_ => panic!("segment {segment} of {path} is not a table"),
		};
	}
	(value.as_table_mut().expect("parent is a table"), last)
}

#[test]
fn shipped_surface_tokens_resolve_scale_references_accurately() {
	let shipped = shipped_dir();
	let tokens = load_from_dir(&shipped).expect("shipped tokens load cleanly");

	// Panels: tabs, tree, diff, chrome, terminal drawer
	assert_eq!(tokens.surface.panels.tabs_gap_px, tokens.scale.spacing(SpacingStep::S1));
	assert_eq!(tokens.surface.panels.tabs_height_px, tokens.scale.spacing(SpacingStep::S10));
	assert_eq!(tokens.surface.panels.tabs_close_hit_px, tokens.scale.spacing(SpacingStep::S8));
	assert_eq!(tokens.surface.panels.tabs_pending_dot_px, tokens.scale.spacing(SpacingStep::S3));
	assert_eq!(tokens.surface.panels.tree_indent_base_px, tokens.scale.spacing(SpacingStep::S4));
	assert_eq!(tokens.surface.panels.tree_indent_step_px, tokens.scale.spacing(SpacingStep::S7));
	assert_eq!(tokens.surface.panels.tree_row_height_px, tokens.scale.spacing(SpacingStep::S10));
	assert_eq!(tokens.surface.panels.diff_sign_width_px, tokens.scale.spacing(SpacingStep::S6));
	assert_eq!(
		tokens.surface.panels.diff_hunk_header_height_px,
		tokens.scale.spacing(SpacingStep::S10)
	);
	assert_eq!(
		tokens.surface.panels.chrome_resize_handle_hit_px,
		tokens.scale.spacing(SpacingStep::S4)
	);
	assert_eq!(
		tokens.surface.panels.chrome_resize_handle_line_px,
		tokens.scale.stroke(StrokeStep::Hairline)
	);
	assert_eq!(tokens.surface.panels.process_row_height_px, tokens.scale.spacing(SpacingStep::S10));
	assert_eq!(tokens.surface.panels.process_dot_px, tokens.scale.spacing(SpacingStep::S3));

	// Queue: section header, card badge/title/subtitle, gear
	assert_eq!(tokens.surface.queue.section_header_px, tokens.scale.spacing(SpacingStep::S9));
	assert_eq!(tokens.surface.queue.card_badge_height, tokens.scale.spacing(SpacingStep::S9));
	assert_eq!(tokens.surface.queue.card_title_height, tokens.scale.spacing(SpacingStep::S9));
	assert_eq!(tokens.surface.queue.card_subtitle_height, tokens.scale.spacing(SpacingStep::S8));
	assert_eq!(tokens.surface.queue.gear_size_px, tokens.scale.spacing(SpacingStep::S8));

	// Transcript: chrome collapsed height, event line height, plan fade
	assert_eq!(
		tokens.surface.transcript.chrome_collapsed_height_px,
		tokens.scale.spacing(SpacingStep::S10)
	);
	assert_eq!(
		tokens.surface.transcript.chrome_event_line_height_px,
		tokens.scale.spacing(SpacingStep::S6)
	);

	// Composer: attachment card height
	assert_eq!(
		tokens.surface.composer.attachment_card_height_px,
		tokens.scale.spacing(SpacingStep::S12)
	);

	// Palette: search icon, group header height, footer height
	assert_eq!(tokens.surface.palette.input_search_icon_px, tokens.scale.spacing(SpacingStep::S8));
	assert_eq!(
		tokens.surface.palette.results_group_header_height_px,
		tokens.scale.spacing(SpacingStep::S9)
	);
	assert_eq!(
		tokens.surface.palette.results_footer_height_px,
		tokens.scale.spacing(SpacingStep::S11)
	);

	// Attached cards: overflow collapsed height, plan fade height
	assert_eq!(
		tokens
			.surface
			.attached_cards
			.stack_overflow_collapsed_height_px,
		tokens.scale.spacing(SpacingStep::S10)
	);
	assert_eq!(
		tokens.surface.attached_cards.plan_fade_height_px,
		tokens.scale.spacing(SpacingStep::S13)
	);
}

#[test]
fn surface_scale_fields_reject_bare_numeric_literals_through_loader() {
	let (_tree, scratch) = copy_shipped("surface-scale-disallow-numbers");
	let files = surface_files();
	let mut tested_fields = 0usize;

	for file_path in files {
		let file_name = file_path.file_name().expect("file name").to_string_lossy();
		let rel_path = Path::new("surface").join(&*file_name);
		let content = fs::read_to_string(&file_path).expect("read surface file");
		let root_val: Value = toml::from_str(&content).expect("parse toml");
		let table = root_val.as_table().expect("root table");

		let mut scale_fields = Vec::new();
		collect_scale_field_paths(table, "", &mut scale_fields);

		for (dotted_path, key_name) in scale_fields {
			let scratch_file = scratch.join(&rel_path);
			let orig_text = fs::read_to_string(&scratch_file).expect("read scratch file");
			let mut scratch_root: toml::map::Map<String, Value> =
				toml::from_str(&orig_text).expect("parse scratch toml");

			let (parent, leaf) = parent_mut(&mut scratch_root, &dotted_path);
			parent.insert(leaf, Value::Integer(42));
			let corrupted_toml = toml::to_string(&Value::Table(scratch_root)).expect("serialize");
			fs::write(&scratch_file, corrupted_toml).expect("write corrupted");

			let result = load_from_dir(&scratch);
			match result {
				Err(TokenError::NumericLiteralDisallowed { key, literal, .. }) => {
					assert_eq!(
						key, key_name,
						"expected NumericLiteralDisallowed for key {key_name} in {file_name}, got {key}"
					);
					assert_eq!(literal, "42");
				},
				Err(other) => {
					panic!(
						"expected NumericLiteralDisallowed for key {key_name} in {file_name}, got: \
						 {other:?}"
					);
				},
				Ok(_) => {
					panic!(
						"loader unexpectedly accepted bare numeric literal 42 for field {dotted_path} \
						 in {file_name}"
					);
				},
			}

			// Restore scratch file
			fs::write(&scratch_file, orig_text).expect("restore scratch file");
			tested_fields += 1;
		}
	}

	assert!(
		tested_fields >= 40,
		"expected at least 40 scale fields tested across surface files, found {tested_fields}"
	);
}
