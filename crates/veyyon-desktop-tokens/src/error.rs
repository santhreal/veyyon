use std::path::PathBuf;

/// Named error types for token loading, parsing, validation, and hot reload.
#[derive(Debug, thiserror::Error)]
pub enum TokenError {
	#[error("IO error reading {path}: {source}")]
	Io {
		path:   PathBuf,
		#[source]
		source: std::io::Error,
	},

	#[error("[{path}:{line}:{column}] TOML parse error: {message}")]
	TomlParse { path: PathBuf, line: usize, column: usize, message: String },

	#[error(
		"[{path}:{line}:{column}] value off scale: {value:?} is not in declared scale {scale_name} \
		 ({allowed})"
	)]
	OffScale {
		path:       PathBuf,
		line:       usize,
		column:     usize,
		value:      String,
		scale_name: String,
		allowed:    String,
	},

	#[error(
		"[{path}] {section} count {count} exceeds ceiling of {ceiling} (defined in §{spec_section})"
	)]
	CeilingExceeded {
		path:         PathBuf,
		section:      String,
		count:        usize,
		ceiling:      usize,
		spec_section: &'static str,
	},

	#[error(
		"[{path}:{line}:{column}] raw numeric literal {literal:?} disallowed for key {key:?}; must \
		 reference scale token (e.g. {example:?})"
	)]
	NumericLiteralDisallowed {
		path:    PathBuf,
		line:    usize,
		column:  usize,
		key:     String,
		literal: String,
		example: String,
	},

	#[error("[{path}] missing required key {key:?} in section [{section}]")]
	MissingKey { path: PathBuf, section: String, key: String },

	#[error(
		"[{path}:{line}:{column}] unknown key {key:?} in section [{section}]; expected one of \
		 {expected:?}"
	)]
	UnknownKey {
		path:     PathBuf,
		line:     usize,
		column:   usize,
		section:  String,
		key:      String,
		expected: Vec<&'static str>,
	},

	#[error(
		"[{path}:{line}:{column}] unresolved token reference {reference:?} for key {key:?}; not \
		 found in {source_file}"
	)]
	UnresolvedReference {
		path:        PathBuf,
		line:        usize,
		column:      usize,
		key:         String,
		reference:   String,
		source_file: &'static str,
	},

	#[error(
		"[{path}:{line}:{column}] contrast ratio {ratio:.1}:1 for pair ({foreground}, {background}) \
		 is below required {required:.1}:1"
	)]
	ContrastTooLow {
		path:       PathBuf,
		line:       usize,
		column:     usize,
		foreground: String,
		background: String,
		ratio:      f32,
		required:   f32,
	},
}
