//! One table of a token file, read through methods that fail loud.
//!
//! Each reader rejects an absent or mistyped key and names the file, the
//! section and the key. Every loader reads through this. A value is never
//! defaulted: section 9.3 states that nothing visual is compiled in, and a
//! default written into a loader is a design value with no file.

use std::path::Path;

use toml::{Value, map::Map};

use crate::{
	error::TokenError,
	loader::{find_key_line_col, validate_table_keys},
	loader_surface::{resolve_radius, resolve_spacing, resolve_stroke, resolve_type_size},
	schema::{ScaleTokens, TypeSize, TypeWeightStep},
};

/// The kind of a TOML value, in the words the error prints.
const fn kind(value: &Value) -> &'static str {
	match value {
		Value::String(_) => "a string",
		Value::Integer(_) => "an integer",
		Value::Float(_) => "a float",
		Value::Boolean(_) => "a boolean",
		Value::Datetime(_) => "a datetime",
		Value::Array(_) => "an array",
		Value::Table(_) => "a table",
	}
}

/// The token file format this binary reads. Every file states it under
/// `[meta] version`.
pub const TOKEN_FILE_VERSION: u32 = 1;

#[derive(Clone)]
pub(crate) struct Section<'a> {
	path:  &'a Path,
	text:  &'a str,
	name:  String,
	table: &'a Map<String, Value>,
}

impl<'a> Section<'a> {
	/// The root table of a parsed file. The section name is `root`.
	pub fn root(path: &'a Path, text: &'a str, value: &'a Value) -> Result<Self, TokenError> {
		let table = value.as_table().ok_or_else(|| TokenError::WrongType {
			path:     path.to_path_buf(),
			line:     1,
			column:   1,
			section:  "root".to_string(),
			key:      String::new(),
			expected: "a table",
			found:    kind(value),
		})?;
		Ok(Self { path, text, name: "root".to_string(), table })
	}

	/// A section reached by a dotted name that is already known, for the
	/// entries of a table iterated by the caller.
	pub const fn named(&self, name: String, table: &'a Map<String, Value>) -> Self {
		Self { path: self.path, text: self.text, name, table }
	}

	pub const fn path(&self) -> &'a Path {
		self.path
	}

	pub const fn text(&self) -> &'a str {
		self.text
	}

	pub fn name(&self) -> &str {
		&self.name
	}

	pub const fn table(&self) -> &'a Map<String, Value> {
		self.table
	}

	/// Rejects any key outside `expected`.
	pub fn only(&self, expected: &[&'static str]) -> Result<(), TokenError> {
		validate_table_keys(self.path, self.text, &self.name, self.table, expected)
	}

	fn missing(&self, key: &str) -> TokenError {
		TokenError::MissingKey {
			path:    self.path.to_path_buf(),
			section: self.name.clone(),
			key:     key.to_string(),
		}
	}

	fn wrong_type(&self, key: &str, expected: &'static str, value: &Value) -> TokenError {
		let (line, column) = find_key_line_col(self.text, &self.name, key);
		TokenError::WrongType {
			path: self.path.to_path_buf(),
			line,
			column,
			section: self.name.clone(),
			key: key.to_string(),
			expected,
			found: kind(value),
		}
	}

	/// The raw value under `key`.
	pub fn get(&self, key: &str) -> Result<&'a Value, TokenError> {
		self.table.get(key).ok_or_else(|| self.missing(key))
	}

	/// The sub-table under `key`, named `<this>.<key>`, or `<key>` at the root.
	pub fn sub(&self, key: &str) -> Result<Self, TokenError> {
		let value = self.get(key)?;
		let table = value
			.as_table()
			.ok_or_else(|| self.wrong_type(key, "a table", value))?;
		let name = if self.name == "root" {
			key.to_string()
		} else {
			format!("{}.{key}", self.name)
		};
		Ok(Section { path: self.path, text: self.text, name, table })
	}

	pub fn integer(&self, key: &str) -> Result<i64, TokenError> {
		let value = self.get(key)?;
		value
			.as_integer()
			.ok_or_else(|| self.wrong_type(key, "an integer", value))
	}

	/// A non-negative integer used as a count.
	pub fn count(&self, key: &str) -> Result<usize, TokenError> {
		let value = self.get(key)?;
		match value {
			Value::Integer(i) if *i >= 0 => Ok(*i as usize),
			_ => Err(self.wrong_type(key, "a count of zero or more", value)),
		}
	}

	/// An integer or a float, as f32.
	pub fn number(&self, key: &str) -> Result<f32, TokenError> {
		let value = self.get(key)?;
		match value {
			Value::Integer(i) => Ok(*i as f32),
			Value::Float(f) => Ok(*f as f32),
			_ => Err(self.wrong_type(key, "a number", value)),
		}
	}

	/// A whole number of pixels, zero or more, as f32. For a key whose file
	/// form is an integer: a breakpoint at 1440.5px or a rail of -8px is
	/// rejected rather than rounded or clamped.
	pub fn pixels(&self, key: &str) -> Result<f32, TokenError> {
		let value = self.get(key)?;
		match value {
			Value::Integer(i) if *i >= 0 => Ok(*i as f32),
			_ => Err(self.wrong_type(key, "a whole number of pixels, zero or more", value)),
		}
	}

	fn off_scale(&self, key: &str, value: f32, allowed: &str) -> TokenError {
		let (line, column) = find_key_line_col(self.text, &self.name, key);
		TokenError::OffScale {
			path: self.path.to_path_buf(),
			line,
			column,
			value: value.to_string(),
			scale_name: format!("{}.{key}", self.name),
			allowed: allowed.to_string(),
		}
	}

	/// A finite number of zero or more: a pixel dimension. A titlebar of
	/// -52px is not a smaller titlebar, it is a layout that computes nonsense
	/// for every row below it.
	pub fn dimension(&self, key: &str) -> Result<f32, TokenError> {
		let value = self.number(key)?;
		if !value.is_finite() || value < 0.0 {
			return Err(self.off_scale(key, value, "a finite dimension of zero or more"));
		}
		Ok(value)
	}

	/// A number in `0.0..=1.0`: an opacity, an alpha or a viewport ratio.
	pub fn ratio(&self, key: &str) -> Result<f32, TokenError> {
		let value = self.number(key)?;
		if !(0.0..=1.0).contains(&value) {
			return Err(self.off_scale(key, value, "0.0 to 1.0"));
		}
		Ok(value)
	}

	pub fn string(&self, key: &str) -> Result<&'a str, TokenError> {
		let value = self.get(key)?;
		value
			.as_str()
			.ok_or_else(|| self.wrong_type(key, "a string", value))
	}

	pub fn boolean(&self, key: &str) -> Result<bool, TokenError> {
		let value = self.get(key)?;
		value
			.as_bool()
			.ok_or_else(|| self.wrong_type(key, "a boolean", value))
	}

	/// The `[meta]` table every token file opens with: `version` is the
	/// format this binary reads and `name` is the file's own name, so a file
	/// copied under the wrong name or written for another format is rejected.
	pub fn meta(&self, expected_name: &str) -> Result<(), TokenError> {
		let meta = self.sub("meta")?;
		meta.only(&["version", "name"])?;
		let found = meta.integer("version")?;
		if found != i64::from(TOKEN_FILE_VERSION) {
			return Err(TokenError::UnsupportedVersion {
				path: self.path.to_path_buf(),
				found,
				supported: TOKEN_FILE_VERSION,
			});
		}
		let name = meta.string("name")?;
		if name != expected_name {
			let (line, column) = find_key_line_col(self.text, "meta", "name");
			return Err(TokenError::OffScale {
				path: self.path.to_path_buf(),
				line,
				column,
				value: name.to_string(),
				scale_name: "meta.name".to_string(),
				allowed: expected_name.to_string(),
			});
		}
		Ok(())
	}

	/// A spacing step reference (`"s4"`), resolved through the scale.
	pub fn spacing(&self, key: &str, scale: &ScaleTokens) -> Result<f32, TokenError> {
		resolve_spacing(self.path, self.text, &self.name, key, self.get(key)?, scale)
	}

	/// A radius step reference (`"xl"`), resolved through the scale.
	pub fn radius(&self, key: &str, scale: &ScaleTokens) -> Result<f32, TokenError> {
		resolve_radius(self.path, self.text, &self.name, key, self.get(key)?, scale)
	}

	/// A stroke width reference (`"hairline"`), resolved through the scale.
	pub fn stroke(&self, key: &str, scale: &ScaleTokens) -> Result<f32, TokenError> {
		resolve_stroke(self.path, self.text, &self.name, key, self.get(key)?, scale)
	}

	/// A type ramp reference (`"body"`), resolved through the scale.
	pub fn type_size(&self, key: &str, scale: &ScaleTokens) -> Result<TypeSize, TokenError> {
		resolve_type_size(self.path, self.text, &self.name, key, self.get(key)?, scale)
	}

	/// A type weight reference (`"medium"`), resolved through the scale.
	pub fn weight(&self, key: &str, scale: &ScaleTokens) -> Result<u16, TokenError> {
		let raw = self.string(key)?;
		let step = TypeWeightStep::from_token(raw).ok_or_else(|| {
			let (line, column) = find_key_line_col(self.text, &self.name, key);
			TokenError::OffScale {
				path: self.path.to_path_buf(),
				line,
				column,
				value: raw.to_string(),
				scale_name: "type.weight".to_string(),
				allowed: "regular, medium, semibold".to_string(),
			}
		})?;
		Ok(scale.type_weight(step))
	}
}
