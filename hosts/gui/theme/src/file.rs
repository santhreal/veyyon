//! The theme file on disk, and resolving the values in it to colours.
//!
//! One format, shared with the terminal front end. A theme file is
//! `{ name, vars?, colors, export?, gui? }`:
//!
//! - `vars` names colours the rest of the file refers to. A theme states
//!   `"#282828"` once and every role that uses it says `"bg0"`.
//! - `colors` holds the terminal's roles. The GUI reads the subset it can use
//!   and derives the rest.
//! - `export` holds the three grounds the HTML exporter paints with, which are
//!   also the three the GUI needs: page, card, panel.
//! - `gui` is optional and overrides a derived role by name. Nothing bundled
//!   uses it.
//!
//! Unknown keys are kept, not rejected: the terminal adds roles, and a theme
//! written for a newer veyyon must still load here.

use std::collections::BTreeMap;

use serde::Deserialize;

use crate::color::{ColorError, Srgb, ansi256, parse_hex};

/// A colour as a theme file writes it: a hex string, the name of a `vars`
/// entry, or a 256-colour palette index.
///
/// `""` is accepted and means "this theme does not set this role". It resolves
/// to the default foreground for the theme's appearance rather than to an
/// error, because a theme that omits a role it does not use is not malformed.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum ColorValue {
	/// A hex colour, a `vars` name, or `""`.
	Text(String),
	/// A 256-colour palette index.
	Index(i64),
}

/// Why a theme file could not be turned into colours.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum ThemeError {
	#[error("theme `{theme}` is not valid json: {message}")]
	Json { theme: String, message: String },
	#[error("theme `{theme}` role `{role}`: {source}")]
	Color { theme: String, role: String, source: ColorError },
	#[error(
		"theme `{theme}` role `{role}` refers to variable `{name}`, which the theme does not define"
	)]
	UnknownVariable { theme: String, role: String, name: String },
	#[error("theme `{theme}` role `{role}`: variable `{name}` refers to itself, through {chain}")]
	CircularVariable { theme: String, role: String, name: String, chain: String },
	#[error(
		"theme `{theme}` sets `gui.{key}`, which is not a colour role. Run `veyyon themes roles` \
		 for the list."
	)]
	UnknownRole { theme: String, key: String },
}

/// A theme file, parsed but not yet resolved.
#[derive(Debug, Clone, Deserialize)]
pub struct ThemeFile {
	/// The theme's name. Also its file stem, and what a setting stores.
	pub name:   String,
	#[serde(default)]
	pub vars:   BTreeMap<String, ColorValue>,
	#[serde(default)]
	pub colors: BTreeMap<String, ColorValue>,
	/// The three grounds the HTML export paints with: `pageBg`, `cardBg`,
	/// `infoBg`. Every bundled theme carries all three.
	#[serde(default)]
	pub export: BTreeMap<String, ColorValue>,
	/// Overrides for the GUI's own roles, keyed by [`crate::Role::key`].
	#[serde(default)]
	pub gui:    BTreeMap<String, ColorValue>,
}

/// How deep a chain of variable references may go before it is treated as a
/// cycle.
///
/// A cycle is detected exactly, by the visited set, so this is only a bound on
/// legitimate nesting. Twelve is far past any hand-written theme and keeps a
/// pathological file from consuming the stack.
const MAX_VAR_DEPTH: usize = 12;

impl ThemeFile {
	/// Parse a theme file. `name` names it in errors; the file's own `name`
	/// field is what the parsed theme carries.
	pub fn parse(name: &str, json: &str) -> Result<ThemeFile, ThemeError> {
		serde_json::from_str(json)
			.map_err(|error| ThemeError::Json { theme: name.to_owned(), message: error.to_string() })
	}

	/// Is this a light theme?
	///
	/// Read from the status-line background, matching `isLightThemeJson`. Not
	/// from the page background: a theme like `porcelain` puts a dark chat
	/// bubble on a light ground, so the bubble's colour answers wrong.
	///
	/// A theme whose status-line background is absent, empty or unresolvable
	/// reads as dark. That is not a guess to paper over a broken file — dark is
	/// the shipped default, the terminal answers the same way for the same
	/// theme, and an unresolvable value is reported by the palette build, which
	/// resolves the same colour into `status.bg`.
	pub fn is_light(&self) -> bool {
		self
			.colors
			.get("statusLineBg")
			.and_then(|value| self.resolve_value("colors.statusLineBg", value).ok())
			.is_some_and(|color| color.luma() > 0.5)
	}

	/// The colour a role holds, or `None` when the theme does not set it.
	///
	/// A role set to `""` reads as unset. That is what the terminal does with
	/// it: an empty string is a role the theme declined to colour, not black.
	pub fn color(&self, group: Group, role: &str) -> Result<Option<Srgb>, ThemeError> {
		let table = match group {
			Group::Colors => &self.colors,
			Group::Export => &self.export,
			Group::Gui => &self.gui,
		};
		let Some(value) = table.get(role) else {
			return Ok(None);
		};
		if matches!(value, ColorValue::Text(text) if text.is_empty()) {
			return Ok(None);
		}
		self
			.resolve_value(&format!("{}.{role}", group.prefix()), value)
			.map(Some)
	}

	/// Resolve one value, following `vars` references.
	fn resolve_value(&self, role: &str, value: &ColorValue) -> Result<Srgb, ThemeError> {
		let mut visited: Vec<&str> = Vec::new();
		let mut current = value;

		for _ in 0..MAX_VAR_DEPTH {
			let text = match current {
				ColorValue::Index(index) => {
					return ansi256(*index).map_err(|source| ThemeError::Color {
						theme: self.name.clone(),
						role: role.to_owned(),
						source,
					});
				},
				ColorValue::Text(text) => text.as_str(),
			};

			if text.starts_with('#') {
				return parse_hex(text).map_err(|source| ThemeError::Color {
					theme: self.name.clone(),
					role: role.to_owned(),
					source,
				});
			}

			// Not a hex colour, so it names a variable.
			let (name, next) = self.variable(role, text)?;
			if visited.contains(&name) {
				visited.push(name);
				return Err(ThemeError::CircularVariable {
					theme: self.name.clone(),
					role:  role.to_owned(),
					name:  name.to_owned(),
					chain: visited.join(" -> "),
				});
			}
			visited.push(name);
			current = next;
		}

		Err(ThemeError::CircularVariable {
			theme: self.name.clone(),
			role:  role.to_owned(),
			name:  visited.last().copied().unwrap_or(role).to_owned(),
			chain: visited.join(" -> "),
		})
	}

	/// The `vars` entry a name refers to, borrowed from the file so the loop
	/// above can walk a chain without cloning at each step.
	fn variable(&self, role: &str, name: &str) -> Result<(&str, &ColorValue), ThemeError> {
		let (key, value) =
			self
				.vars
				.get_key_value(name)
				.ok_or_else(|| ThemeError::UnknownVariable {
					theme: self.name.clone(),
					role:  role.to_owned(),
					name:  name.to_owned(),
				})?;
		Ok((key.as_str(), value))
	}
}

/// Which block of a theme file a role lives in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Group {
	Colors,
	Export,
	Gui,
}

impl Group {
	const fn prefix(self) -> &'static str {
		match self {
			Group::Colors => "colors",
			Group::Export => "export",
			Group::Gui => "gui",
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn theme(json: &str) -> ThemeFile {
		ThemeFile::parse("test", json).expect("parses")
	}

	#[test]
	fn a_hex_colour_resolves_directly() {
		let file = theme(r##"{ "name": "t", "colors": { "text": "#ff8800" } }"##);
		assert_eq!(file.color(Group::Colors, "text").unwrap(), Some(Srgb::opaque(0xff, 0x88, 0x00)));
	}

	#[test]
	fn an_index_resolves_through_the_palette() {
		let file = theme(r##"{ "name": "t", "colors": { "text": 33 } }"##);
		assert_eq!(file.color(Group::Colors, "text").unwrap(), Some(Srgb::opaque(0, 135, 255)));
	}

	#[test]
	fn a_variable_reference_resolves() {
		let file =
			theme(r##"{ "name": "t", "vars": { "fg": "#eeeeee" }, "colors": { "text": "fg" } }"##);
		assert_eq!(file.color(Group::Colors, "text").unwrap(), Some(Srgb::opaque(0xee, 0xee, 0xee)));
	}

	/// A variable may point at another variable. Bundled themes do this — a
	/// semantic name over a palette name.
	#[test]
	fn a_chain_of_variables_resolves() {
		let file = theme(
			r##"{
				"name": "t",
				"vars": { "base": "#101010", "ground": "base", "canvas": "ground" },
				"colors": { "text": "canvas" }
			}"##,
		);
		assert_eq!(file.color(Group::Colors, "text").unwrap(), Some(Srgb::opaque(0x10, 0x10, 0x10)));
	}

	/// A cycle is reported with the chain, not walked until the stack ends.
	#[test]
	fn a_cycle_is_reported_with_its_chain() {
		let file = theme(
			r##"{
				"name": "t",
				"vars": { "a": "b", "b": "c", "c": "a" },
				"colors": { "text": "a" }
			}"##,
		);
		let error = file.color(Group::Colors, "text").expect_err("cycle");
		let ThemeError::CircularVariable { name, chain, .. } = error else {
			panic!("wrong error: {error}");
		};
		assert_eq!(name, "a");
		assert_eq!(chain, "a -> b -> c -> a");
	}

	/// A variable pointing at itself is the shortest cycle and still terminates.
	#[test]
	fn a_self_reference_terminates() {
		let file = theme(r##"{ "name": "t", "vars": { "a": "a" }, "colors": { "text": "a" } }"##);
		let error = file.color(Group::Colors, "text").expect_err("cycle");
		assert!(matches!(error, ThemeError::CircularVariable { .. }), "{error}");
	}

	#[test]
	fn an_unknown_variable_names_itself_and_the_role() {
		let file = theme(r##"{ "name": "t", "colors": { "text": "nope" } }"##);
		let error = file.color(Group::Colors, "text").expect_err("unknown");
		let ThemeError::UnknownVariable { role, name, .. } = error else {
			panic!("wrong error: {error}");
		};
		assert_eq!(role, "colors.text");
		assert_eq!(name, "nope");
	}

	/// An empty string is a role the theme declined to set, and reads as unset
	/// rather than as black. A theme that omits `toolDiffContext` should fall
	/// back to a derived colour, not paint text invisible.
	#[test]
	fn an_empty_value_reads_as_unset() {
		let file = theme(r##"{ "name": "t", "colors": { "text": "" } }"##);
		assert_eq!(file.color(Group::Colors, "text").unwrap(), None);
	}

	#[test]
	fn a_missing_role_reads_as_unset() {
		let file = theme(r##"{ "name": "t", "colors": {} }"##);
		assert_eq!(file.color(Group::Colors, "absent").unwrap(), None);
	}

	/// Light and dark come from the status-line background. A theme that does
	/// not resolve one reads as dark, which is the answer the terminal gives for
	/// the same file.
	#[test]
	fn appearance_comes_from_the_status_line() {
		let dark = theme(r##"{ "name": "t", "colors": { "statusLineBg": "#1e1e2e" } }"##);
		assert!(!dark.is_light());

		let light = theme(r##"{ "name": "t", "colors": { "statusLineBg": "#fafaf8" } }"##);
		assert!(light.is_light());

		// The threshold sits on luma, so a saturated colour is classified by
		// its green weight rather than by looking bright.
		let green = theme(r##"{ "name": "t", "colors": { "statusLineBg": "#00ff00" } }"##);
		assert!(green.is_light());
		let blue = theme(r##"{ "name": "t", "colors": { "statusLineBg": "#0000ff" } }"##);
		assert!(!blue.is_light());

		for broken in [
			r##"{ "name": "t", "colors": {} }"##,
			r##"{ "name": "t", "colors": { "statusLineBg": "" } }"##,
			r##"{ "name": "t", "colors": { "statusLineBg": "undefinedVar" } }"##,
		] {
			assert!(!theme(broken).is_light(), "{broken} was not classified dark");
		}
	}

	/// A theme carrying a role this version does not know still loads. The
	/// terminal front end adds roles, and a shared format cannot break the GUI
	/// every time it does.
	#[test]
	fn an_unknown_role_in_colors_does_not_fail_the_parse() {
		let file =
			theme(r##"{ "name": "t", "colors": { "somethingNew": "#123456" }, "unknownBlock": 7 }"##);
		assert_eq!(
			file.color(Group::Colors, "somethingNew").unwrap(),
			Some(Srgb::opaque(0x12, 0x34, 0x56))
		);
	}

	/// The error names the theme and the role, because the operator sees it
	/// after editing one line of one file and has to find that line.
	#[test]
	fn an_error_names_the_theme_and_the_role() {
		let file =
			ThemeFile::parse("my-theme", r##"{ "name": "my-theme", "colors": { "text": "#zz" } }"##)
				.unwrap();
		let message = file
			.color(Group::Colors, "text")
			.expect_err("bad hex")
			.to_string();
		assert!(message.contains("my-theme"), "{message}");
		assert!(message.contains("colors.text"), "{message}");
	}

	#[test]
	fn malformed_json_is_reported_against_the_theme_name() {
		let error = ThemeFile::parse("broken", "{ not json").expect_err("malformed");
		let ThemeError::Json { theme, .. } = error else {
			panic!("wrong error")
		};
		assert_eq!(theme, "broken");
	}
}
