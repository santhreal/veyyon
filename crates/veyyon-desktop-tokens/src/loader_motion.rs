use std::path::Path;

use toml::Value;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file, validate_table_keys},
	motion::{
		DirectThenSpringModel, DurationModel, EasingCurve, FlipModel, MotionModel, MotionRole,
		MotionRoleConfig, MotionTokens, ReducedMotion, SpringFadeModel, SpringModel, TwoStepModel,
	},
};

/// Parses and validates motion.toml.
pub fn load_motion(path: &Path) -> Result<MotionTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = val.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "root".to_string(),
		key:     "role".to_string(),
	})?;

	validate_table_keys(path, &text, "root", root, &["meta", "role"])?;

	let role_tbl =
		root
			.get("role")
			.and_then(Value::as_table)
			.ok_or_else(|| TokenError::MissingKey {
				path:    path.to_path_buf(),
				section: "root".to_string(),
				key:     "role".to_string(),
			})?;

	fn parse_role_config(
		path: &Path,
		tbl: &toml::map::Map<String, Value>,
		role: MotionRole,
	) -> Result<MotionRoleConfig, TokenError> {
		let name = role.as_str();
		let section =
			tbl.get(name)
				.and_then(Value::as_table)
				.ok_or_else(|| TokenError::MissingKey {
					path:    path.to_path_buf(),
					section: format!("role.{name}"),
					key:     "model".to_string(),
				})?;

		let model_kind = section.get("model").and_then(Value::as_str).unwrap_or("");
		let reduced_str = section
			.get("reduced_motion")
			.and_then(Value::as_str)
			.unwrap_or("instant");
		let reduced_motion =
			ReducedMotion::from_str_name(reduced_str).unwrap_or(ReducedMotion::Instant);

		let model = match model_kind {
			"duration" => {
				let duration_ms = section
					.get("duration_ms")
					.and_then(Value::as_integer)
					.unwrap_or(0) as u32;
				let curve_str = section
					.get("curve")
					.and_then(Value::as_str)
					.unwrap_or("linear");
				let curve = EasingCurve::from_str_name(curve_str).unwrap_or(EasingCurve::Linear);
				MotionModel::Duration(DurationModel { duration_ms, curve })
			},
			"spring" => {
				let stiffness = section
					.get("stiffness")
					.and_then(Value::as_float)
					.unwrap_or(200.0) as f32;
				let damping = section
					.get("damping")
					.and_then(Value::as_float)
					.unwrap_or(20.0) as f32;
				let mass = section.get("mass").and_then(Value::as_float).unwrap_or(1.0) as f32;
				MotionModel::Spring(SpringModel { stiffness, damping, mass })
			},
			"spring_fade" => {
				let stiffness = section
					.get("stiffness")
					.and_then(Value::as_float)
					.unwrap_or(300.0) as f32;
				let damping = section
					.get("damping")
					.and_then(Value::as_float)
					.unwrap_or(24.0) as f32;
				let mass = section.get("mass").and_then(Value::as_float).unwrap_or(1.0) as f32;
				let rise_px = section
					.get("rise_px")
					.and_then(Value::as_float)
					.unwrap_or(4.0) as f32;
				let fade_duration_ms = section
					.get("fade_duration_ms")
					.and_then(Value::as_integer)
					.unwrap_or(90) as u32;
				MotionModel::SpringFade(SpringFadeModel {
					spring: SpringModel { stiffness, damping, mass },
					rise_px,
					fade_duration_ms,
				})
			},
			"direct_then_spring" => {
				let stiffness = section
					.get("stiffness")
					.and_then(Value::as_float)
					.unwrap_or(180.0) as f32;
				let damping = section
					.get("damping")
					.and_then(Value::as_float)
					.unwrap_or(22.0) as f32;
				let mass = section.get("mass").and_then(Value::as_float).unwrap_or(1.0) as f32;
				MotionModel::DirectThenSpring(DirectThenSpringModel {
					snap_spring: SpringModel { stiffness, damping, mass },
				})
			},
			"flip" => {
				let duration_ms = section
					.get("duration_ms")
					.and_then(Value::as_integer)
					.unwrap_or(200) as u32;
				let curve_str = section
					.get("curve")
					.and_then(Value::as_str)
					.unwrap_or("ease_out");
				let curve = EasingCurve::from_str_name(curve_str).unwrap_or(EasingCurve::EaseOut);
				MotionModel::Flip(FlipModel { duration_ms, curve })
			},
			"two_step" => {
				let period_ms = section
					.get("period_ms")
					.and_then(Value::as_integer)
					.unwrap_or(900) as u32;
				MotionModel::TwoStep(TwoStepModel { period_ms })
			},
			other => {
				return Err(TokenError::UnknownKey {
					path:     path.to_path_buf(),
					line:     1,
					column:   1,
					section:  format!("role.{name}"),
					key:      other.to_string(),
					expected: vec![
						"duration",
						"spring",
						"spring_fade",
						"direct_then_spring",
						"flip",
						"two_step",
					],
				});
			},
		};

		Ok(MotionRoleConfig { model, reduced_motion })
	}

	Ok(MotionTokens {
		tint:   parse_role_config(path, role_tbl, MotionRole::Tint)?,
		reveal: parse_role_config(path, role_tbl, MotionRole::Reveal)?,
		float:  parse_role_config(path, role_tbl, MotionRole::Float)?,
		panel:  parse_role_config(path, role_tbl, MotionRole::Panel)?,
		shift:  parse_role_config(path, role_tbl, MotionRole::Shift)?,
		scroll: parse_role_config(path, role_tbl, MotionRole::Scroll)?,
		caret:  parse_role_config(path, role_tbl, MotionRole::Caret)?,
	})
}
