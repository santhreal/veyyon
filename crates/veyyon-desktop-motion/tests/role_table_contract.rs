use veyyon_desktop_motion::{ALL_ROLES, MotionError, MotionRole, MotionTokens};

#[test]
fn the_seven_motion_roles_are_swept_from_enum_and_opt_outs_are_pinned_by_exact_equality() {
	let roles = MotionRole::all();

	// Enumerate the variant space from source at run time
	assert_eq!(roles.len(), 7, "Motion role space must have exactly 7 roles (§7.1)");

	let expected_roles = [
		MotionRole::Tint,
		MotionRole::Reveal,
		MotionRole::Float,
		MotionRole::Panel,
		MotionRole::Shift,
		MotionRole::Scroll,
		MotionRole::Caret,
	];

	// Pin opt-outs and membership by exact equality
	assert_eq!(roles, &expected_roles);

	for role in roles {
		let name = role.name();
		let parsed = MotionRole::from_name(name).expect("Role must round-trip through its name");
		assert_eq!(*role, parsed);
	}
}

#[test]
fn every_role_parameters_load_from_token_table() {
	let toml_str = r#"
[meta]
version = 1
name = "motion"

[role.tint]
model = "duration"
duration_ms = 120
curve = "ease_out"
reduced_motion = "instant"

[role.reveal]
model = "spring"
stiffness = 220.0
damping = 26.0
mass = 1.0
reduced_motion = "fade_instant"

[role.float]
model = "spring_fade"
stiffness = 300.0
damping = 24.0
mass = 1.0
rise_px = 4.0
fade_duration_ms = 90
reduced_motion = "opacity_only"

[role.panel]
model = "direct_then_spring"
stiffness = 180.0
damping = 22.0
mass = 1.0
reduced_motion = "direct"

[role.shift]
model = "flip"
duration_ms = 200
curve = "ease_out"
reduced_motion = "instant"

[role.scroll]
model = "duration"
duration_ms = 240
curve = "ease_in_out"
reduced_motion = "instant"

[role.caret]
model = "two_step"
period_ms = 900
reduced_motion = "steady_on"
"#;

	let tokens =
		MotionTokens::from_toml_str(toml_str).expect("Valid motion.toml must parse cleanly");
	assert_eq!(tokens.tint.duration_ms, 120);
	assert_eq!(tokens.reveal.stiffness, 220.0);
	assert_eq!(tokens.reveal.damping, 26.0);
	assert_eq!(tokens.reveal.mass, 1.0);
	assert_eq!(tokens.float.rise_px, 4.0);
	assert_eq!(tokens.float.fade_duration_ms, 90);
	assert_eq!(tokens.panel.snap_spring.stiffness, 180.0);
	assert_eq!(tokens.shift.duration_ms, 200);
	assert_eq!(tokens.scroll.duration_ms, 240);
	assert_eq!(tokens.caret.period_ms, 900);
}

#[test]
fn a_role_missing_from_motion_toml_is_a_loud_failure_naming_the_role() {
	for missing_role in &ALL_ROLES {
		let mut toml_str = String::from("[meta]\nversion = 1\nname = \"motion\"\n");
		for role in &ALL_ROLES {
			if role == missing_role {
				continue;
			}
			match role {
				MotionRole::Tint => toml_str.push_str(
					"[role.tint]\nmodel = \"duration\"\nduration_ms = 120\ncurve = \"ease_out\"\n",
				),
				MotionRole::Reveal => toml_str.push_str(
					"[role.reveal]\nmodel = \"spring\"\nstiffness = 220.0\ndamping = 26.0\nmass = 1.0\n",
				),
				MotionRole::Float => toml_str.push_str(
					"[role.float]\nmodel = \"spring_fade\"\nstiffness = 300.0\ndamping = 24.0\nmass = \
					 1.0\nrise_px = 4.0\nfade_duration_ms = 90\n",
				),
				MotionRole::Panel => toml_str.push_str(
					"[role.panel]\nmodel = \"direct_then_spring\"\nstiffness = 180.0\ndamping = \
					 22.0\nmass = 1.0\n",
				),
				MotionRole::Shift => toml_str.push_str(
					"[role.shift]\nmodel = \"flip\"\nduration_ms = 200\ncurve = \"ease_out\"\n",
				),
				MotionRole::Scroll => toml_str.push_str(
					"[role.scroll]\nmodel = \"duration\"\nduration_ms = 240\ncurve = \"ease_in_out\"\n",
				),
				MotionRole::Caret => {
					toml_str.push_str("[role.caret]\nmodel = \"two_step\"\nperiod_ms = 900\n");
				},
			}
		}

		let err =
			MotionTokens::from_toml_str(&toml_str).expect_err("Omission of a required role must fail");
		match err {
			MotionError::MissingRole(name) => {
				assert_eq!(name, missing_role.name(), "Error must explicitly name the missing role");
			},
			other => panic!("Expected MissingRole({}), got {:?}", missing_role.name(), other),
		}
	}
}
