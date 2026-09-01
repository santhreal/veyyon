//! Theme loading: one TOML file declaring exactly the roles in §6.4.
//!
//! §6.9 makes every failure loud, because a theme is edited by hand and a
//! substituted colour is an unreadable surface rather than a degraded one. A
//! missing role, an unknown key, an unsupported version, a malformed hex value
//! and a contrast pair under the floor each report which rule was broken; the
//! caller keeps the theme it already had.
//!
//! The file shape is derived from `ColorRole`, not restated here. A role whose
//! name ends in `_fill` or `_ink` is read from its `[tint.<name>]` block and
//! every other role from `[role]`, so adding a role to the enum makes every
//! theme file fail to load until it declares one.

use std::{collections::HashMap, path::Path};

use toml::{Value, map::Map};

use crate::{
	color::{ColorRole, RgbColor, Theme},
	error::TokenError,
	loader::{find_key_line_col, parse_toml, read_file, validate_table_keys},
};

/// The one theme schema version this binary reads (§6.9).
pub const THEME_VERSION: u32 = 1;

/// Contrast floor for text at body size and above (§6.9).
const BODY_CONTRAST: f32 = 4.5;

/// Contrast floor for text at `micro` (§6.9).
const MICRO_CONTRAST: f32 = 3.0;

/// The appearances a theme may declare. §6.9 ships one bundled theme per
/// appearance, and they are the reference the contrast rules are asserted
/// against.
pub const APPEARANCES: [&str; 2] = ["dark", "light"];

/// The grounds text is drawn on, from the §6.5 elevation table. A text role has
/// to clear its floor against every one of them, because the same role is used
/// on all five and the lightest ground is what decides legibility.
const GROUNDS: [ColorRole; 5] =
	[ColorRole::Ground, ColorRole::Rail, ColorRole::Canvas, ColorRole::Inset, ColorRole::Float];

/// Text roles rendered at body size or larger.
const BODY_INKS: [ColorRole; 2] = [ColorRole::Foreground, ColorRole::Secondary];

/// Text roles rendered at `micro`, which §6.9 holds to the lower floor.
const MICRO_INKS: [ColorRole; 2] = [ColorRole::Muted, ColorRole::Placeholder];

/// The `[role]`, `[tint]` and `[meta]` sections, and nothing else.
const ROOT_SECTIONS: [&str; 3] = ["meta", "role", "tint"];

/// The two keys a tint block declares.
const TINT_SLOTS: [&str; 2] = ["fill", "ink"];

/// Splits a role into the tint block and key it is read from.
///
/// Returns `None` for a role that lives directly in `[role]`.
fn tint_of(role: ColorRole) -> Option<(&'static str, &'static str)> {
	let name = role.as_str();
	if let Some(tint) = name.strip_suffix("_fill") {
		return Some((tint, "fill"));
	}
	name.strip_suffix("_ink").map(|tint| (tint, "ink"))
}

/// Resolves the role a tint block's key supplies.
fn role_for(tint: &str, slot: &str) -> Option<ColorRole> {
	ColorRole::all()
		.into_iter()
		.find(|role| tint_of(*role) == Some((tint, slot)))
}

/// Roles read from the `[role]` table, in canonical order.
fn base_roles() -> Vec<ColorRole> {
	ColorRole::all()
		.into_iter()
		.filter(|role| tint_of(*role).is_none())
		.collect()
}

/// Tint block names, in canonical role order.
fn tint_names() -> Vec<&'static str> {
	ColorRole::all()
		.into_iter()
		.filter_map(tint_of)
		.filter(|(_, slot)| *slot == "fill")
		.map(|(tint, _)| tint)
		.collect()
}

/// Reads a required table, reporting the section rather than a type error.
fn require_table<'a>(
	path: &Path,
	parent: &'a Map<String, Value>,
	section: &str,
) -> Result<&'a Map<String, Value>, TokenError> {
	parent
		.get(section)
		.and_then(Value::as_table)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: section.to_string(),
			key:     section.to_string(),
		})
}

/// Reads a required string key.
fn require_str<'a>(
	path: &Path,
	table: &'a Map<String, Value>,
	section: &str,
	key: &str,
) -> Result<&'a str, TokenError> {
	table
		.get(key)
		.and_then(Value::as_str)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: section.to_string(),
			key:     key.to_string(),
		})
}

/// Parses one hex value, naming the key and the value when it is malformed.
fn colour(
	path: &Path,
	text: &str,
	section: &str,
	key: &str,
	raw: &str,
) -> Result<RgbColor, TokenError> {
	RgbColor::from_hex(raw).map_err(|source| {
		let (line, column) = find_key_line_col(text, section, key);
		TokenError::ColorInvalid {
			path: path.to_path_buf(),
			line,
			column,
			key: key.to_string(),
			value: raw.to_string(),
			source,
		}
	})
}

/// Reads and range-checks `[meta] version`.
fn require_version(path: &Path, meta: &Map<String, Value>) -> Result<u32, TokenError> {
	let found = meta
		.get("version")
		.and_then(Value::as_integer)
		.ok_or_else(|| TokenError::MissingKey {
			path:    path.to_path_buf(),
			section: "meta".to_string(),
			key:     "version".to_string(),
		})?;

	if found != i64::from(THEME_VERSION) {
		return Err(TokenError::UnsupportedVersion {
			path: path.to_path_buf(),
			found,
			supported: THEME_VERSION,
		});
	}
	Ok(THEME_VERSION)
}

/// Asserts every pair that is actually rendered together.
///
/// Each text role is checked against all five grounds because one role serves
/// all of them; each tint ink against its own fill because a badge draws them
/// as a pair; and `accent_foreground` against `accent` because that is the only
/// ground it appears on.
fn assert_contrast_matrix(theme: &Theme, path: &Path, text: &str) -> Result<(), TokenError> {
	for (inks, floor) in [(BODY_INKS, BODY_CONTRAST), (MICRO_INKS, MICRO_CONTRAST)] {
		for ink in inks {
			let (line, column) = find_key_line_col(text, "role", ink.as_str());
			for ground in GROUNDS {
				theme.assert_contrast(path, ink, ground, floor, line, column)?;
			}
		}
	}

	let (line, column) = find_key_line_col(text, "role", ColorRole::AccentForeground.as_str());
	theme.assert_contrast(
		path,
		ColorRole::AccentForeground,
		ColorRole::Accent,
		BODY_CONTRAST,
		line,
		column,
	)?;

	for tint in tint_names() {
		let section = format!("tint.{tint}");
		let (line, column) = find_key_line_col(text, &section, "ink");
		let (Some(ink), Some(fill)) = (role_for(tint, "ink"), role_for(tint, "fill")) else {
			return Err(TokenError::MissingKey {
				path: path.to_path_buf(),
				section,
				key: "ink".to_string(),
			});
		};
		theme.assert_contrast(path, ink, fill, BODY_CONTRAST, line, column)?;
	}
	Ok(())
}

/// Parses and validates one theme file per §6.9.
pub fn load_theme(path: &Path) -> Result<Theme, TokenError> {
	let text = read_file(path)?;
	let parsed = parse_toml(path, &text)?;
	let root = parsed.as_table().ok_or_else(|| TokenError::MissingKey {
		path:    path.to_path_buf(),
		section: "meta".to_string(),
		key:     "meta".to_string(),
	})?;
	validate_table_keys(path, &text, "", root, &ROOT_SECTIONS)?;

	let meta = require_table(path, root, "meta")?;
	validate_table_keys(path, &text, "meta", meta, &["name", "appearance", "version"])?;
	let name = require_str(path, meta, "meta", "name")?.to_string();
	let appearance = require_str(path, meta, "meta", "appearance")?.to_string();
	if !APPEARANCES.contains(&appearance.as_str()) {
		let (line, column) = find_key_line_col(&text, "meta", "appearance");
		return Err(TokenError::OffScale {
			path: path.to_path_buf(),
			line,
			column,
			value: appearance,
			scale_name: "appearance".to_string(),
			allowed: APPEARANCES.join(", "),
		});
	}
	let version = require_version(path, meta)?;

	let mut roles = HashMap::new();

	let base = base_roles();
	let expected_base: Vec<&'static str> = base.iter().map(|role| role.as_str()).collect();
	let role_table = require_table(path, root, "role")?;
	validate_table_keys(path, &text, "role", role_table, &expected_base)?;
	for role in base {
		let key = role.as_str();
		let raw = require_str(path, role_table, "role", key)?;
		roles.insert(role, colour(path, &text, "role", key, raw)?);
	}

	let names = tint_names();
	let tint_root = require_table(path, root, "tint")?;
	validate_table_keys(path, &text, "tint", tint_root, &names)?;
	for tint in names {
		let section = format!("tint.{tint}");
		let block = require_table(path, tint_root, tint)?;
		validate_table_keys(path, &text, &section, block, &TINT_SLOTS)?;
		for slot in TINT_SLOTS {
			let role = role_for(tint, slot).ok_or_else(|| TokenError::MissingKey {
				path:    path.to_path_buf(),
				section: section.clone(),
				key:     slot.to_string(),
			})?;
			let raw = require_str(path, block, &section, slot)?;
			roles.insert(role, colour(path, &text, &section, slot, raw)?);
		}
	}

	let theme = Theme { name, appearance, version, roles };
	assert_contrast_matrix(&theme, path, &text)?;
	Ok(theme)
}

/// Loads the bundled themes, one per appearance (§6.9).
///
/// Reads `<dir>/<appearance>.toml`. Both are required: a build that ships one
/// appearance cannot honour a light-mode host.
pub fn load_bundled_themes(dir: &Path) -> Result<Vec<Theme>, TokenError> {
	let mut themes = Vec::with_capacity(APPEARANCES.len());
	for appearance in APPEARANCES {
		themes.push(load_theme(&dir.join(format!("{appearance}.toml")))?);
	}
	Ok(themes)
}

/// Loads a bundled theme by appearance ("dark" or "light").
pub fn load_bundled_theme(appearance: &str) -> Result<Theme, TokenError> {
	let path = Path::new(env!("CARGO_MANIFEST_DIR"))
		.join("themes")
		.join(format!("{appearance}.toml"));
	load_theme(&path)
}
