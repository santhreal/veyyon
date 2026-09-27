use std::path::Path;

use motion::{
	DirectThenSpringModel, DurationModel, Easing, FlipModel, MotionRole, MotionTokens, SpringConfig,
	SpringFadeModel, TwoStepModel,
};

use crate::{
	error::TokenError,
	loader::{find_key_line_col, parse_toml, read_file},
	section::Section,
};

/// The key a role table may not declare: `motion::resolve_motion` is the
/// single definition of each role's reduced variant.
const REDUCED_MOTION_KEY: &str = "reduced_motion";

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

fn curve(section: &Section<'_>) -> Result<Easing, TokenError> {
	let raw = section.string("curve")?;
	Easing::from_name(raw).map_err(|_| off_scale(section, "curve", raw, Easing::NAMES.join(", ")))
}

fn spring(section: &Section<'_>) -> Result<SpringConfig, TokenError> {
	let stiffness = section.number("stiffness")?;
	let damping = section.number("damping")?;
	let mass = section.number("mass")?;
	SpringConfig::try_new(stiffness, damping, mass).map_err(|error| {
		off_scale(
			section,
			"stiffness",
			&format!("stiffness {stiffness}, damping {damping}, mass {mass}"),
			error.to_string(),
		)
	})
}

/// The model name each role runs. `motion::MotionTokens` fixes one model per
/// role, so the file states it and the loader checks it.
const fn model_name(role: MotionRole) -> &'static str {
	match role {
		MotionRole::Tint | MotionRole::Scroll => "duration",
		MotionRole::Reveal => "spring",
		MotionRole::Float => "spring_fade",
		MotionRole::Panel => "direct_then_spring",
		MotionRole::Shift => "flip",
		MotionRole::Caret => "two_step",
	}
}

/// The parameter keys of a role's model, after `model`.
const fn parameters(role: MotionRole) -> &'static [&'static str] {
	match role {
		MotionRole::Tint | MotionRole::Scroll | MotionRole::Shift => {
			&["model", "duration_ms", "curve"]
		},
		MotionRole::Reveal | MotionRole::Panel => &["model", "stiffness", "damping", "mass"],
		MotionRole::Float => {
			&["model", "stiffness", "damping", "mass", "rise_px", "fade_duration_ms"]
		},
		MotionRole::Caret => &["model", "period_ms"],
	}
}

/// One `[role.<name>]` table, checked against the model the role runs. A
/// `reduced_motion` key is rejected, and so is any parameter another model
/// would read.
fn role_section<'a>(role_tbl: &Section<'a>, role: MotionRole) -> Result<Section<'a>, TokenError> {
	let section = role_tbl.sub(role.name())?;
	if section.table().contains_key(REDUCED_MOTION_KEY) {
		let (line, column) = find_key_line_col(section.text(), section.name(), REDUCED_MOTION_KEY);
		return Err(TokenError::ReducedMotionFixed {
			path: section.path().to_path_buf(),
			line,
			column,
			section: section.name().to_string(),
		});
	}
	let expected = model_name(role);
	let declared = section.string("model")?;
	if declared != expected {
		return Err(off_scale(&section, "model", declared, expected.to_string()));
	}
	section.only(parameters(role))?;
	Ok(section)
}

/// Parses and validates motion.toml.
pub fn load_motion(path: &Path) -> Result<MotionTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "role"])?;
	root.meta("motion")?;

	let role_tbl = root.sub("role")?;
	role_tbl.only(&MotionRole::NAMES)?;

	let tint = role_section(&role_tbl, MotionRole::Tint)?;
	let reveal = role_section(&role_tbl, MotionRole::Reveal)?;
	let float = role_section(&role_tbl, MotionRole::Float)?;
	let panel = role_section(&role_tbl, MotionRole::Panel)?;
	let shift = role_section(&role_tbl, MotionRole::Shift)?;
	let scroll = role_section(&role_tbl, MotionRole::Scroll)?;
	let caret = role_section(&role_tbl, MotionRole::Caret)?;

	Ok(MotionTokens {
		tint:   DurationModel {
			duration_ms: millis(&tint, "duration_ms")?,
			curve:       curve(&tint)?,
		},
		reveal: spring(&reveal)?,
		float:  SpringFadeModel {
			spring:           spring(&float)?,
			rise_px:          float.number("rise_px")?,
			fade_duration_ms: millis(&float, "fade_duration_ms")?,
		},
		panel:  DirectThenSpringModel { snap_spring: spring(&panel)? },
		shift:  FlipModel {
			duration_ms: millis(&shift, "duration_ms")?,
			curve:       curve(&shift)?,
		},
		scroll: DurationModel {
			duration_ms: millis(&scroll, "duration_ms")?,
			curve:       curve(&scroll)?,
		},
		caret:  TwoStepModel { period_ms: millis(&caret, "period_ms")? },
	})
}
