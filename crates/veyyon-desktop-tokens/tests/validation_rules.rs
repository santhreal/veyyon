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

/// WHY: An unvalidated or unknown `right_panel_mode` string loading into the
/// token tree causes layout logic to behave unpredictably or fail silently.
/// This test ensures every malformed or unknown mode variant fails loud during
/// token loading with a precise `TokenError::OffScale` naming the file,
/// section, scale name, and offending value.
#[test]
fn test_validation_rule_right_panel_mode_off_scale() {
	let invalid_modes = ["sidebar", "inline_", "inline_abc", "inline_0", "inline_-40"];

	for mode in invalid_modes {
		let (_tree, dir) = setup_temp_tokens_dir();
		let bp_path = dir.join("surface/breakpoints.toml");
		let content = fs::read_to_string(&bp_path).unwrap();
		let modified = content
			.replace("right_panel_mode = \"inline_540\"", &format!("right_panel_mode = \"{mode}\""));
		fs::write(&bp_path, modified).unwrap();

		let err =
			load_from_dir(&dir).expect_err(&format!("mode {mode:?} should fail off-scale validation"));
		match &err {
			TokenError::OffScale { path, value, scale_name, allowed, .. } => {
				assert!(path.ends_with("surface/breakpoints.toml"));
				assert_eq!(value, mode);
				assert_eq!(scale_name, "breakpoint.wide.right_panel_mode");
				assert_eq!(allowed, "\"overlay\" or \"inline_<px>\"");
			},
			other => panic!("expected OffScale for mode {mode:?}, got {other:?}"),
		}
		let err_msg = err.to_string();
		assert!(err_msg.contains(&format!(
			"value off scale: {mode:?} is not in declared scale breakpoint.wide.right_panel_mode \
			 (\"overlay\" or \"inline_<px>\")"
		)));
	}
}

/// WHY: the drawer's placement decides whether it takes 180px out of the
/// transcript or covers it, so a value nobody validated is a layout nobody
/// chose. Only the two declared placements load; everything else names the
/// file, the row and the allowed set.
#[test]
fn test_validation_rule_terminal_drawer_placement_off_scale() {
	for placement in ["dock", "sheet", "", "Row", "overlay_row"] {
		let (_tree, dir) = setup_temp_tokens_dir();
		let bp_path = dir.join("surface/breakpoints.toml");
		let content = fs::read_to_string(&bp_path).unwrap();
		let modified = content.replacen(
			"terminal_drawer_placement = \"row\"",
			&format!("terminal_drawer_placement = \"{placement}\""),
			1,
		);
		fs::write(&bp_path, modified).unwrap();

		let err = load_from_dir(&dir)
			.expect_err(&format!("placement {placement:?} should fail off-scale validation"));
		match &err {
			TokenError::OffScale { path, value, scale_name, allowed, .. } => {
				assert!(path.ends_with("surface/breakpoints.toml"));
				assert_eq!(value, placement);
				assert_eq!(scale_name, "breakpoint.wide.terminal_drawer_placement");
				assert_eq!(allowed, "\"row\" or \"overlay\"");
			},
			other => panic!("expected OffScale for placement {placement:?}, got {other:?}"),
		}
	}
}

/// WHY: every value in a breakpoint row has a default, so a misspelled key was
/// silently ignored and the default shipped instead. A misspelled
/// `queue_width_px` defaulted to 0, collapsing the queue rail at every width
/// with no error anywhere. The row is key-validated, so the typo is the error.
#[test]
fn test_validation_rule_unknown_breakpoint_row_key() {
	let (_tree, dir) = setup_temp_tokens_dir();
	let bp_path = dir.join("surface/breakpoints.toml");
	let content = fs::read_to_string(&bp_path).unwrap();
	let modified = content.replacen("queue_width_px = 256", "queue_widht_px = 256", 1);
	fs::write(&bp_path, modified).unwrap();

	let err = load_from_dir(&dir).expect_err("a misspelled row key must fail the load");
	match &err {
		TokenError::UnknownKey { path, section, key, .. } => {
			assert!(path.ends_with("surface/breakpoints.toml"));
			assert_eq!(section, "breakpoint.wide");
			assert_eq!(key, "queue_widht_px");
		},
		other => panic!("expected UnknownKey for a misspelled row key, got {other:?}"),
	}
}

/// WHY: a misspelled row header leaves the real row absent while the file
/// still looks complete, and the absent row used to load as every default at
/// once — a 0px queue, an overlaid panel and a 180px drawer.
#[test]
fn test_validation_rule_misspelled_breakpoint_row() {
	let (_tree, dir) = setup_temp_tokens_dir();
	let bp_path = dir.join("surface/breakpoints.toml");
	let content = fs::read_to_string(&bp_path).unwrap();
	let modified = content.replacen("[breakpoint.compact]", "[breakpoint.compakt]", 1);
	fs::write(&bp_path, modified).unwrap();

	let err = load_from_dir(&dir).expect_err("a missing row must fail the load");
	match &err {
		TokenError::UnknownKey { path, section, key, .. } => {
			assert!(path.ends_with("surface/breakpoints.toml"));
			assert_eq!(section, "breakpoint");
			assert_eq!(key, "compakt");
		},
		other => panic!("expected UnknownKey naming the misspelled row, got {other:?}"),
	}
}

/// WHY: the same defect with the header deleted rather than misspelled. The
/// row names are fixed, so an absent one is a missing key, not a default.
#[test]
fn test_validation_rule_absent_breakpoint_row() {
	let (_tree, dir) = setup_temp_tokens_dir();
	let bp_path = dir.join("surface/breakpoints.toml");
	let content = fs::read_to_string(&bp_path).unwrap();
	let header = "[breakpoint.collapsed]";
	let cut = content
		.find(header)
		.expect("shipped tokens declare the collapsed row");
	fs::write(&bp_path, &content[..cut]).unwrap();

	let err = load_from_dir(&dir).expect_err("an absent row must fail the load");
	match &err {
		TokenError::MissingKey { path, section, key } => {
			assert!(path.ends_with("surface/breakpoints.toml"));
			assert_eq!(section, "breakpoint");
			assert_eq!(key, "collapsed");
		},
		other => panic!("expected MissingKey naming the absent row, got {other:?}"),
	}
}

/// WHY: every value in a row had a default reached through `unwrap_or`, so a
/// value of the wrong TOML type — a quoted width, a float, a string boolean —
/// was discarded and the default shipped. Each one now names its own key.
#[test]
fn test_validation_rule_breakpoint_row_value_wrong_type() {
	let cases = [
		("queue_width_px = 256", "queue_width_px = \"256\"", "queue_width_px"),
		("min_width_px = 1440", "min_width_px = 1440.5", "min_width_px"),
		(
			"terminal_drawer_height_px = 280",
			"terminal_drawer_height_px = -8",
			"terminal_drawer_height_px",
		),
		("run_bar_labels = true", "run_bar_labels = \"true\"", "run_bar_labels"),
		("right_panel_mode = \"inline_540\"", "right_panel_mode = 540", "right_panel_mode"),
		(
			"terminal_drawer_placement = \"row\"",
			"terminal_drawer_placement = true",
			"terminal_drawer_placement",
		),
	];

	for (from, to, key) in cases {
		let (_tree, dir) = setup_temp_tokens_dir();
		let bp_path = dir.join("surface/breakpoints.toml");
		let content = fs::read_to_string(&bp_path).unwrap();
		let modified = content.replacen(from, to, 1);
		assert_ne!(modified, content, "case {to:?} matched nothing in the shipped row");
		fs::write(&bp_path, modified).unwrap();

		let err = load_from_dir(&dir).expect_err(&format!("{to:?} must fail the load"));
		match &err {
			TokenError::OffScale { path, scale_name, .. } => {
				assert!(path.ends_with("surface/breakpoints.toml"));
				assert_eq!(scale_name, &format!("breakpoint.wide.{key}"));
			},
			other => panic!("expected OffScale for {to:?}, got {other:?}"),
		}
	}
}

/// WHY: an absent value is the other half of the same fail-open — the key is
/// simply not there and `unwrap_or` supplied a layout nobody declared.
#[test]
fn test_validation_rule_breakpoint_row_value_absent() {
	let keys = [
		("min_width_px = 1440\n", "min_width_px"),
		("queue_width_px = 256\n", "queue_width_px"),
		("right_panel_mode = \"inline_540\"\n", "right_panel_mode"),
		("terminal_drawer_placement = \"row\"\n", "terminal_drawer_placement"),
		("terminal_drawer_height_px = 280\n", "terminal_drawer_height_px"),
		("composer_footer_labels = true\n", "composer_footer_labels"),
		("run_bar_labels = true\n", "run_bar_labels"),
	];

	for (line, key) in keys {
		let (_tree, dir) = setup_temp_tokens_dir();
		let bp_path = dir.join("surface/breakpoints.toml");
		let content = fs::read_to_string(&bp_path).unwrap();
		let modified = content.replacen(line, "", 1);
		assert_ne!(modified, content, "case {key:?} matched nothing in the shipped row");
		fs::write(&bp_path, modified).unwrap();

		let err = load_from_dir(&dir).expect_err(&format!("an absent {key} must fail the load"));
		match &err {
			TokenError::MissingKey { path, section, key: missing } => {
				assert!(path.ends_with("surface/breakpoints.toml"));
				assert_eq!(section, "breakpoint.wide");
				assert_eq!(missing, key);
			},
			other => panic!("expected MissingKey for an absent {key}, got {other:?}"),
		}
	}
}
