use std::{fs, path::Path};

use veyyon_desktop_tokens::{TokenError, dump_to_dir, load_from_dir};
use veyyon_test_scratch::{TempTree, scratch_dir};

fn setup_temp_tokens_dir() -> (TempTree, std::path::PathBuf) {
	let tree = scratch_dir("tokens-validation-rules");
	let shipped_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens");
	let tokens = load_from_dir(&shipped_dir).expect("load shipped tokens");
	dump_to_dir(&tokens, tree.path()).expect("dump tokens to temp");
	let path = tree.path().to_path_buf();
	(tree, path)
}

#[test]
fn test_validation_rule_1_value_off_scale() {
	let (_tree, dir) = setup_temp_tokens_dir();
	let queue_path = dir.join("surface/queue.toml");
	let content = fs::read_to_string(&queue_path).unwrap();
	let modified = content.replace("content_inset = \"s4\"", "content_inset = \"s14\"");
	fs::write(&queue_path, modified).unwrap();

	let err = load_from_dir(&dir).expect_err("s14 should fail off-scale validation");
	match &err {
		TokenError::OffScale { path, value, scale_name, allowed, .. } => {
			assert!(path.ends_with("surface/queue.toml"));
			assert_eq!(value, "s14");
			assert_eq!(scale_name, "spacing");
			assert_eq!(allowed, "s0..s13");
		},
		other => panic!("expected OffScale, got {other:?}"),
	}
	let err_msg = err.to_string();
	assert!(err_msg.contains("value off scale: \"s14\" is not in declared scale spacing (s0..s13)"));
}

#[test]
fn test_validation_rule_2_ceiling_exceeded() {
	let (_tree, dir) = setup_temp_tokens_dir();
	let scale_path = dir.join("scale.toml");
	let content = fs::read_to_string(&scale_path).unwrap();
	let modified = content.replace("[spacing]\n", "[spacing]\ns14 = 80\ns15 = 96\ns16 = 112\n");
	fs::write(&scale_path, modified).unwrap();
	let err = load_from_dir(&dir).expect_err("17 spacing steps should exceed ceiling of 16");
	match &err {
		TokenError::CeilingExceeded { path, section, count, ceiling, spec_section } => {
			assert!(path.ends_with("scale.toml"));
			assert_eq!(section, "spacing scale");
			assert_eq!(*count, 17);
			assert_eq!(*ceiling, 16);
			assert_eq!(*spec_section, "6.1");
		},
		other => panic!("expected CeilingExceeded, got {other:?}"),
	}
	let err_msg = err.to_string();
	assert!(err_msg.contains("spacing scale count 17 exceeds ceiling of 16 (defined in §6.1)"));
}

#[test]
fn test_validation_rule_3_numeric_literal_disallowed() {
	let (_tree, dir) = setup_temp_tokens_dir();
	let composer_path = dir.join("surface/composer.toml");
	let content = fs::read_to_string(&composer_path).unwrap();
	let modified = content.replace("padding_top = \"s7\"", "padding_top = 14");
	fs::write(&composer_path, modified).unwrap();

	let err = load_from_dir(&dir).expect_err("raw numeric literal for padding_top should fail");
	match &err {
		TokenError::NumericLiteralDisallowed { path, key, literal, example, .. } => {
			assert!(path.ends_with("surface/composer.toml"));
			assert_eq!(key, "padding_top");
			assert_eq!(literal, "14");
			assert_eq!(example, "s7");
		},
		other => panic!("expected NumericLiteralDisallowed, got {other:?}"),
	}
	let err_msg = err.to_string();
	assert!(err_msg.contains(
		"raw numeric literal \"14\" disallowed for key \"padding_top\"; must reference scale token \
		 (e.g. \"s7\")"
	));
}

#[test]
fn test_validation_rule_4_missing_required_key() {
	let (_tree, dir) = setup_temp_tokens_dir();
	let composer_path = dir.join("surface/composer.toml");
	let content = fs::read_to_string(&composer_path).unwrap();
	let modified = content.replace("growth_cap_px = 200\n", "");
	fs::write(&composer_path, modified).unwrap();

	let err = load_from_dir(&dir).expect_err("missing growth_cap_px should fail");
	match &err {
		TokenError::MissingKey { path, section, key } => {
			assert!(path.ends_with("surface/composer.toml"));
			assert_eq!(section, "geometry");
			assert_eq!(key, "growth_cap_px");
		},
		other => panic!("expected MissingKey, got {other:?}"),
	}
	let err_msg = err.to_string();
	assert!(err_msg.contains("missing required key \"growth_cap_px\" in section [geometry]"));
}

#[test]
fn test_validation_rule_5_unknown_key() {
	let (_tree, dir) = setup_temp_tokens_dir();
	let palette_path = dir.join("surface/palette.toml");
	let content = fs::read_to_string(&palette_path).unwrap();
	let modified = content.replace("[geometry]\n", "[geometry]\nshadow_blur = 24\n");
	fs::write(&palette_path, modified).unwrap();

	let err =
		load_from_dir(&dir).expect_err("unknown key shadow_blur in palette geometry should fail");
	match &err {
		TokenError::UnknownKey { path, section, key, expected, .. } => {
			assert!(path.ends_with("surface/palette.toml"));
			assert_eq!(section, "geometry");
			assert_eq!(key, "shadow_blur");
			assert!(expected.contains(&"width_px"));
		},
		other => panic!("expected UnknownKey, got {other:?}"),
	}
	let err_msg = err.to_string();
	assert!(err_msg.contains(
		"unknown key \"shadow_blur\" in section [geometry]; expected one of [\"width_px\", \
		 \"max_height_px\", \"radius\", \"elevation_level\"]"
	));
}

#[test]
fn test_validation_rule_6_unresolved_reference() {
	let (_tree, dir) = setup_temp_tokens_dir();
	let composer_path = dir.join("surface/composer.toml");
	let content = fs::read_to_string(&composer_path).unwrap();
	let modified = content.replace("radius_outer = \"xxl\"", "radius_outer = \"r-huge\"");
	fs::write(&composer_path, modified).unwrap();

	let err = load_from_dir(&dir).expect_err("unresolved radius reference r-huge should fail");
	match &err {
		TokenError::UnresolvedReference { path, key, reference, source_file, .. } => {
			assert!(path.ends_with("surface/composer.toml"));
			assert_eq!(key, "radius_outer");
			assert_eq!(reference, "r-huge");
			assert_eq!(*source_file, "scale.toml");
		},
		other => panic!("expected UnresolvedReference, got {other:?}"),
	}
	let err_msg = err.to_string();
	assert!(err_msg.contains(
		"unresolved token reference \"r-huge\" for key \"radius_outer\"; not found in scale.toml"
	));
}
