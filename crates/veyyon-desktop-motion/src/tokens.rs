use crate::{
	curves::EasingCurve,
	error::MotionError,
	role::{
		ALL_ROLES, DirectThenSpringModel, DurationModel, FlipModel, MotionModel, MotionRole,
		SpringFadeModel, TwoStepModel,
	},
	spring::SpringModel,
};

/// Fully parsed motion token table declaring parameters for the 7 roles (§8.20
/// item 4).
#[derive(Debug, Clone, PartialEq)]
pub struct MotionTokens {
	pub tint:   DurationModel,
	pub reveal: SpringModel,
	pub float:  SpringFadeModel,
	pub panel:  DirectThenSpringModel,
	pub shift:  FlipModel,
	pub scroll: DurationModel,
	pub caret:  TwoStepModel,
}

impl MotionTokens {
	/// Returns the default reference motion token parameters per plan §7.1.
	pub const fn reference() -> Self {
		Self {
			tint:   DurationModel { duration_ms: 120, curve: EasingCurve::EaseOut },
			reveal: SpringModel { stiffness: 220.0, damping: 26.0, mass: 1.0 },
			float:  SpringFadeModel {
				spring:           SpringModel { stiffness: 300.0, damping: 24.0, mass: 1.0 },
				rise_px:          4.0,
				fade_duration_ms: 90,
			},
			panel:  DirectThenSpringModel {
				snap_spring: SpringModel { stiffness: 180.0, damping: 22.0, mass: 1.0 },
			},
			shift:  FlipModel { duration_ms: 200, curve: EasingCurve::EaseOut },
			scroll: DurationModel { duration_ms: 240, curve: EasingCurve::EaseInOut },
			caret:  TwoStepModel { period_ms: 900 },
		}
	}

	/// Returns the [`MotionModel`] associated with a given role.
	pub const fn get_model(&self, role: MotionRole) -> MotionModel {
		match role {
			MotionRole::Tint => MotionModel::Duration(self.tint),
			MotionRole::Reveal => MotionModel::Spring(self.reveal),
			MotionRole::Float => MotionModel::SpringFade(self.float),
			MotionRole::Panel => MotionModel::DirectThenSpring(self.panel),
			MotionRole::Shift => MotionModel::Flip(self.shift),
			MotionRole::Scroll => MotionModel::Duration(self.scroll),
			MotionRole::Caret => MotionModel::TwoStep(self.caret),
		}
	}

	/// Parses a TOML string representing `motion.toml` per §8.20 item 4.
	///
	/// # Errors
	/// Returns [`MotionError::MissingRole`] if any of the 7 required roles is
	/// missing, or [`MotionError::ParseError`] on syntax or structure failures.
	pub fn from_toml_str(s: &str) -> Result<Self, MotionError> {
		let table: toml::Table = s
			.parse()
			.map_err(|e: toml::de::Error| MotionError::ParseError(e.to_string()))?;

		let role_table = table
			.get("role")
			.and_then(|v| v.as_table())
			.ok_or_else(|| MotionError::ParseError("missing [role] table in motion.toml".into()))?;

		for role in &ALL_ROLES {
			if !role_table.contains_key(role.name()) {
				return Err(MotionError::MissingRole(role.name().to_string()));
			}
		}

		fn get_sub<'a>(table: &'a toml::Table, name: &str) -> Result<&'a toml::Table, MotionError> {
			table
				.get(name)
				.and_then(|v| v.as_table())
				.ok_or_else(|| MotionError::MissingRole(name.into()))
		}
		fn get_f(t: &toml::Table, k: &str) -> Result<f32, MotionError> {
			t.get(k)
				.and_then(|v| v.as_float())
				.map(|v| v as f32)
				.ok_or_else(|| MotionError::ParseError(format!("missing float key {k}")))
		}
		fn get_u(t: &toml::Table, k: &str) -> Result<u32, MotionError> {
			t.get(k)
				.and_then(|v| v.as_integer())
				.map(|v| v as u32)
				.ok_or_else(|| MotionError::ParseError(format!("missing integer key {k}")))
		}
		fn get_s<'a>(t: &'a toml::Table, k: &str) -> Result<&'a str, MotionError> {
			t.get(k)
				.and_then(|v| v.as_str())
				.ok_or_else(|| MotionError::ParseError(format!("missing string key {k}")))
		}

		let t_tint = get_sub(role_table, "tint")?;
		let tint = DurationModel {
			duration_ms: get_u(t_tint, "duration_ms")?,
			curve:       EasingCurve::from_name(get_s(t_tint, "curve")?)?,
		};

		let t_rev = get_sub(role_table, "reveal")?;
		let reveal = SpringModel::new(
			get_f(t_rev, "stiffness")?,
			get_f(t_rev, "damping")?,
			get_f(t_rev, "mass")?,
		)?;

		let t_flt = get_sub(role_table, "float")?;
		let float = SpringFadeModel {
			spring:           SpringModel::new(
				get_f(t_flt, "stiffness")?,
				get_f(t_flt, "damping")?,
				get_f(t_flt, "mass")?,
			)?,
			rise_px:          get_f(t_flt, "rise_px")?,
			fade_duration_ms: get_u(t_flt, "fade_duration_ms")?,
		};

		let t_pnl = get_sub(role_table, "panel")?;
		let panel = DirectThenSpringModel {
			snap_spring: SpringModel::new(
				get_f(t_pnl, "stiffness")?,
				get_f(t_pnl, "damping")?,
				get_f(t_pnl, "mass")?,
			)?,
		};

		let t_shf = get_sub(role_table, "shift")?;
		let shift = FlipModel {
			duration_ms: get_u(t_shf, "duration_ms")?,
			curve:       EasingCurve::from_name(get_s(t_shf, "curve")?)?,
		};

		let t_scr = get_sub(role_table, "scroll")?;
		let scroll = DurationModel {
			duration_ms: get_u(t_scr, "duration_ms")?,
			curve:       EasingCurve::from_name(get_s(t_scr, "curve")?)?,
		};

		let t_crt = get_sub(role_table, "caret")?;
		let caret = TwoStepModel { period_ms: get_u(t_crt, "period_ms")? };

		Ok(Self { tint, reveal, float, panel, shift, scroll, caret })
	}
}

impl From<veyyon_desktop_tokens::MotionTokens> for MotionTokens {
	fn from(tokens: veyyon_desktop_tokens::MotionTokens) -> Self {
		let tint = match tokens.tint.model {
			veyyon_desktop_tokens::MotionModel::Duration(d) => {
				DurationModel { duration_ms: d.duration_ms, curve: d.curve.into() }
			},
			_ => DurationModel { duration_ms: 120, curve: EasingCurve::EaseOut },
		};
		let reveal = match tokens.reveal.model {
			veyyon_desktop_tokens::MotionModel::Spring(s) => s.into(),
			_ => SpringModel { stiffness: 220.0, damping: 26.0, mass: 1.0 },
		};
		let float = match tokens.float.model {
			veyyon_desktop_tokens::MotionModel::SpringFade(sf) => SpringFadeModel {
				spring:           sf.spring.into(),
				rise_px:          sf.rise_px,
				fade_duration_ms: sf.fade_duration_ms,
			},
			_ => SpringFadeModel {
				spring:           SpringModel { stiffness: 300.0, damping: 24.0, mass: 1.0 },
				rise_px:          4.0,
				fade_duration_ms: 90,
			},
		};
		let panel = match tokens.panel.model {
			veyyon_desktop_tokens::MotionModel::DirectThenSpring(d) => {
				DirectThenSpringModel { snap_spring: d.snap_spring.into() }
			},
			_ => DirectThenSpringModel {
				snap_spring: SpringModel { stiffness: 180.0, damping: 22.0, mass: 1.0 },
			},
		};
		let shift = match tokens.shift.model {
			veyyon_desktop_tokens::MotionModel::Flip(f) => {
				FlipModel { duration_ms: f.duration_ms, curve: f.curve.into() }
			},
			_ => FlipModel { duration_ms: 200, curve: EasingCurve::EaseOut },
		};
		let scroll = match tokens.scroll.model {
			veyyon_desktop_tokens::MotionModel::Duration(d) => {
				DurationModel { duration_ms: d.duration_ms, curve: d.curve.into() }
			},
			_ => DurationModel { duration_ms: 240, curve: EasingCurve::EaseInOut },
		};
		let caret = match tokens.caret.model {
			veyyon_desktop_tokens::MotionModel::TwoStep(ts) => {
				TwoStepModel { period_ms: ts.period_ms }
			},
			_ => TwoStepModel { period_ms: 900 },
		};
		Self { tint, reveal, float, panel, shift, scroll, caret }
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_load_from_reference_toml() {
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
		let tokens = MotionTokens::from_toml_str(toml_str).unwrap();
		assert_eq!(tokens.tint.duration_ms, 120);
		assert_eq!(tokens.reveal.stiffness, 220.0);
		assert_eq!(tokens.float.rise_px, 4.0);
		assert_eq!(tokens.panel.snap_spring.stiffness, 180.0);
		assert_eq!(tokens.shift.duration_ms, 200);
		assert_eq!(tokens.scroll.duration_ms, 240);
		assert_eq!(tokens.caret.period_ms, 900);
	}

	#[test]
	fn test_missing_each_role_fails_loudly_naming_role() {
		for missing_role in &ALL_ROLES {
			let mut full_toml = String::from("[meta]\nversion = 1\nname = \"motion\"\n");
			for role in &ALL_ROLES {
				if role == missing_role {
					continue;
				}
				match role {
					MotionRole::Tint => full_toml.push_str(
						"[role.tint]\nmodel = \"duration\"\nduration_ms = 120\ncurve = \"ease_out\"\n",
					),
					MotionRole::Reveal => full_toml.push_str(
						"[role.reveal]\nmodel = \"spring\"\nstiffness = 220.0\ndamping = 26.0\nmass = \
						 1.0\n",
					),
					MotionRole::Float => full_toml.push_str(
						"[role.float]\nmodel = \"spring_fade\"\nstiffness = 300.0\ndamping = 24.0\nmass \
						 = 1.0\nrise_px = 4.0\nfade_duration_ms = 90\n",
					),
					MotionRole::Panel => full_toml.push_str(
						"[role.panel]\nmodel = \"direct_then_spring\"\nstiffness = 180.0\ndamping = \
						 22.0\nmass = 1.0\n",
					),
					MotionRole::Shift => full_toml.push_str(
						"[role.shift]\nmodel = \"flip\"\nduration_ms = 200\ncurve = \"ease_out\"\n",
					),
					MotionRole::Scroll => full_toml.push_str(
						"[role.scroll]\nmodel = \"duration\"\nduration_ms = 240\ncurve = \
						 \"ease_in_out\"\n",
					),
					MotionRole::Caret => {
						full_toml.push_str("[role.caret]\nmodel = \"two_step\"\nperiod_ms = 900\n");
					},
				}
			}
			let err = MotionTokens::from_toml_str(&full_toml).unwrap_err();
			match err {
				MotionError::MissingRole(name) => {
					assert_eq!(name, missing_role.name());
				},
				other => panic!("Expected MissingRole({}), got {:?}", missing_role.name(), other),
			}
		}
	}
}
