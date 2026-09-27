//! WHY: `motion.toml` once declared a `reduced_motion` variant and a free
//! `model` per role, and neither reached any animation: the framework's
//! `motion::resolve_motion` is the single definition of each role's reduced
//! variant, and `motion::MotionTokens` fixes one model per role. A file could
//! set `reduced_motion = "direct"` on the panel, or a spring on the scroll
//! role, and load in silence while every animation ignored it. The dumper
//! wrote a fixed literal instead of the tokens it was given, so an edited
//! motion value did not survive a dump and reload.
//!
//! The class this closes is a motion key that loads and is never read. The
//! sweeps enumerate `motion::MotionRole::ALL` at run time, so a role the
//! framework adds turns the suite red until the shipped file and the loader
//! state its model. Each role must reject a `reduced_motion` key with the
//! error stating that reduced motion is fixed per role, and must reject every
//! model name except its own.
//!
//! It does not catch a parameter the framework adds to a role's model, which
//! fails to compile here instead.

use std::{fmt::Write as _, fs, path::Path};

use motion::{Easing, MotionRole, MotionTokens, SpringConfig};
use veyyon_desktop_tokens::{
	TokenError, dump_to_dir, load_bundled_tokens, load_from_dir, loader_motion::load_motion,
};
use veyyon_test_scratch::scratch_dir;

/// Every model name the file format has used.
const MODEL_NAMES: [&str; 6] =
	["duration", "spring", "spring_fade", "direct_then_spring", "flip", "two_step"];

fn shipped_text() -> String {
	let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tokens/motion.toml");
	fs::read_to_string(path).expect("read shipped motion.toml")
}

/// Rewrites the table of `role`: `edit` receives each line of that table and
/// returns the lines written in its place.
fn edit_role(text: &str, role: MotionRole, mut edit: impl FnMut(&str) -> Vec<String>) -> String {
	let header = format!("[role.{}]", role.name());
	let mut out = String::with_capacity(text.len() + 64);
	let mut inside = false;
	for line in text.lines() {
		if line.starts_with('[') {
			inside = line == header;
			writeln!(out, "{line}").expect("write into a String");
			continue;
		}
		if inside {
			for replaced in edit(line) {
				writeln!(out, "{replaced}").expect("write into a String");
			}
		} else {
			writeln!(out, "{line}").expect("write into a String");
		}
	}
	out
}

fn load_text(dir: &Path, name: &str, text: &str) -> Result<MotionTokens, TokenError> {
	let path = dir.join(format!("{name}.toml"));
	fs::write(&path, text).expect("write probe motion file");
	load_motion(&path)
}

/// The model line of `role` in the shipped file.
fn declared_model(text: &str, role: MotionRole) -> String {
	let mut found = None;
	edit_role(text, role, |line| {
		if let Some(value) = line.strip_prefix("model = ") {
			found.get_or_insert_with(|| value.trim_matches('"').to_string());
		}
		vec![line.to_string()]
	});
	found.unwrap_or_else(|| panic!("role.{} declares no model", role.name()))
}

#[test]
fn the_shipped_file_loads_to_the_framework_reference_parameters() {
	let tokens = load_bundled_tokens().expect("load bundled tokens");
	assert_eq!(tokens.motion, MotionTokens::reference());
}

#[test]
fn every_role_rejects_a_reduced_motion_key() {
	let text = shipped_text();
	let tree = scratch_dir("desktop-tokens-motion-reduced");
	for role in MotionRole::ALL {
		let probe = edit_role(&text, role, |line| {
			if line.starts_with("model = ") {
				vec![line.to_string(), "reduced_motion = \"instant\"".to_string()]
			} else {
				vec![line.to_string()]
			}
		});
		let err = load_text(tree.path(), role.name(), &probe)
			.expect_err("a reduced_motion key must fail the motion file");
		let expected_section = format!("role.{}", role.name());
		match &err {
			TokenError::ReducedMotionFixed { section, line, .. } => {
				assert_eq!(section, &expected_section);
				let reported = probe.lines().nth(line - 1).expect("reported line exists");
				assert!(
					reported.starts_with("reduced_motion"),
					"{expected_section}: reported line {line} is {reported:?}"
				);
			},
			other => panic!("{expected_section}: expected ReducedMotionFixed, got {other:?}"),
		}
		assert!(
			err.to_string().contains("reduced motion is fixed per role"),
			"{expected_section}: message does not state the rule: {err}"
		);
	}
}

#[test]
fn every_role_rejects_every_model_but_its_own() {
	let text = shipped_text();
	let tree = scratch_dir("desktop-tokens-motion-model");
	for role in MotionRole::ALL {
		let own = declared_model(&text, role);
		assert!(MODEL_NAMES.contains(&own.as_str()), "role.{} declares {own}", role.name());
		for other in MODEL_NAMES.iter().filter(|name| **name != own) {
			let probe = edit_role(&text, role, |line| {
				if line.starts_with("model = ") {
					vec![format!("model = \"{other}\"")]
				} else {
					vec![line.to_string()]
				}
			});
			let err = load_text(tree.path(), role.name(), &probe)
				.expect_err("a model the role does not run must fail the motion file");
			match err {
				TokenError::OffScale { value, scale_name, allowed, .. } => {
					assert_eq!(value, *other);
					assert_eq!(scale_name, format!("role.{}.model", role.name()));
					assert_eq!(allowed, own);
				},
				other_err => panic!("role.{}: expected OffScale, got {other_err:?}", role.name()),
			}
		}
	}
}

#[test]
fn a_dump_writes_the_motion_values_it_is_given() {
	let mut tokens = load_bundled_tokens().expect("load bundled tokens");
	tokens.motion.tint.duration_ms = 75;
	tokens.motion.tint.curve = Easing::Standard;
	tokens.motion.reveal = SpringConfig::new(260.0, 30.0, 1.5);
	tokens.motion.float.rise_px = 6.0;
	tokens.motion.float.fade_duration_ms = 110;
	tokens.motion.panel.snap_spring = SpringConfig::new(200.0, 20.0, 2.0);
	tokens.motion.shift.duration_ms = 180;
	tokens.motion.shift.curve = Easing::EaseResort;
	tokens.motion.scroll.duration_ms = 300;
	tokens.motion.caret.period_ms = 1000;

	let tree = scratch_dir("desktop-tokens-motion-dump");
	dump_to_dir(&tokens, tree.path()).expect("dump tokens");
	let reloaded = load_from_dir(tree.path()).expect("reload dumped tokens");
	assert_eq!(reloaded.motion, tokens.motion);
}
