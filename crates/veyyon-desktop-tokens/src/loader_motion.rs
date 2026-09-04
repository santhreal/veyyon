use std::path::Path;

use crate::{
	error::TokenError,
	loader::{find_key_line_col, parse_toml, read_file},
	motion::{
		DirectThenSpringModel, DurationModel, EasingCurve, FlipModel, MotionModel, MotionRole,
		MotionRoleConfig, MotionTokens, ReducedMotion, SpringFadeModel, SpringModel, TwoStepModel,
	},
	section::Section,
};

const MODELS: [&str; 6] =
	["duration", "spring", "spring_fade", "direct_then_spring", "flip", "two_step"];
const CURVES: [&str; 3] = ["ease_out", "ease_in_out", "linear"];
const REDUCED: [&str; 5] = ["instant", "fade_instant", "opacity_only", "direct", "steady_on"];

fn off_scale(section: &Section<'_>, key: &str, value: &str, allowed: String) -> TokenError {
	let (line, column) = find_key_line_col(section.text(), section.name(), key);
	TokenError::OffScale {
		path: section.path().to_path_buf(),
		line,
		column,
		value: value.to_string(),
		scale_name: format!("{}.{key}", section.name()),
		allowed,
	}
}

/// A string key whose value must be one of a fixed vocabulary.
fn word<T>(
	section: &Section<'_>,
	key: &str,
	parse: fn(&str) -> Option<T>,
	allowed: &[&'static str],
) -> Result<T, TokenError> {
	let raw = section.string(key)?;
	parse(raw).ok_or_else(|| off_scale(section, key, raw, allowed.join(", ")))
}

fn millis(section: &Section<'_>, key: &str) -> Result<u32, TokenError> {
	let value = section.integer(key)?;
	u32::try_from(value).map_err(|_| {
		off_scale(
			section,
			key,
			&value.to_string(),
			"a duration in milliseconds, zero or more".to_string(),
		)
	})
}

fn spring(section: &Section<'_>) -> Result<SpringModel, TokenError> {
	Ok(SpringModel {
		stiffness: section.number("stiffness")?,
		damping:   section.number("damping")?,
		mass:      section.number("mass")?,
	})
}

/// One `[role.<name>]` table. The key set is fixed by the model the role
/// declares, so a parameter another model would read is rejected here.
fn parse_role_config(
	role_tbl: &Section<'_>,
	role: MotionRole,
) -> Result<MotionRoleConfig, TokenError> {
	let section = role_tbl.sub(role.as_str())?;
	let raw_model = section.string("model")?;
	let model_kind: &'static str = MODELS
		.iter()
		.copied()
		.find(|m| *m == raw_model)
		.ok_or_else(|| off_scale(&section, "model", raw_model, MODELS.join(", ")))?;
	let common: [&'static str; 2] = ["model", "reduced_motion"];
	let params: &[&'static str] = match model_kind {
		"duration" | "flip" => &["duration_ms", "curve"],
		"spring" | "direct_then_spring" => &["stiffness", "damping", "mass"],
		"spring_fade" => &["stiffness", "damping", "mass", "rise_px", "fade_duration_ms"],
		_ => &["period_ms"],
	};
	let expected: Vec<&'static str> = common.iter().chain(params.iter()).copied().collect();
	section.only(&expected)?;

	let reduced_motion = word(&section, "reduced_motion", ReducedMotion::from_str_name, &REDUCED)?;
	let model = match model_kind {
		"duration" => MotionModel::Duration(DurationModel {
			duration_ms: millis(&section, "duration_ms")?,
			curve:       word(&section, "curve", EasingCurve::from_str_name, &CURVES)?,
		}),
		"spring" => MotionModel::Spring(spring(&section)?),
		"spring_fade" => MotionModel::SpringFade(SpringFadeModel {
			spring:           spring(&section)?,
			rise_px:          section.number("rise_px")?,
			fade_duration_ms: millis(&section, "fade_duration_ms")?,
		}),
		"direct_then_spring" => {
			MotionModel::DirectThenSpring(DirectThenSpringModel { snap_spring: spring(&section)? })
		},
		"flip" => MotionModel::Flip(FlipModel {
			duration_ms: millis(&section, "duration_ms")?,
			curve:       word(&section, "curve", EasingCurve::from_str_name, &CURVES)?,
		}),
		_ => MotionModel::TwoStep(TwoStepModel { period_ms: millis(&section, "period_ms")? }),
	};

	Ok(MotionRoleConfig { model, reduced_motion })
}

/// Parses and validates motion.toml.
pub fn load_motion(path: &Path) -> Result<MotionTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "role"])?;
	root.meta("motion")?;

	let role_tbl = root.sub("role")?;
	let roles: Vec<&'static str> = MotionRole::all().iter().map(|r| r.as_str()).collect();
	role_tbl.only(&roles)?;

	Ok(MotionTokens {
		tint:   parse_role_config(&role_tbl, MotionRole::Tint)?,
		reveal: parse_role_config(&role_tbl, MotionRole::Reveal)?,
		float:  parse_role_config(&role_tbl, MotionRole::Float)?,
		panel:  parse_role_config(&role_tbl, MotionRole::Panel)?,
		shift:  parse_role_config(&role_tbl, MotionRole::Shift)?,
		scroll: parse_role_config(&role_tbl, MotionRole::Scroll)?,
		caret:  parse_role_config(&role_tbl, MotionRole::Caret)?,
	})
}
