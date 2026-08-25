//! N-API surface for syntax highlighting.
//!
//! The highlighting itself, the scope-to-category mapping and the syntax set
//! live in `veyyon_highlight`; this module only adapts the options object and
//! the return types.

use napi_derive::napi;
use veyyon_highlight::Palette;

/// Theme colors for syntax highlighting.
/// Each color is an ANSI escape sequence (e.g., "\x1b[38;2;255;0;0m").
#[derive(Debug)]
#[napi(object)]
pub struct HighlightColors {
	/// ANSI color for comments.
	pub comment:     String,
	/// ANSI color for keywords.
	pub keyword:     String,
	/// ANSI color for function names.
	pub function:    String,
	/// ANSI color for variables and identifiers.
	pub variable:    String,
	/// ANSI color for string literals.
	pub string:      String,
	/// ANSI color for numeric literals.
	pub number:      String,
	/// ANSI color for type identifiers.
	pub r#type:      String,
	/// ANSI color for operators.
	pub operator:    String,
	/// ANSI color for punctuation tokens.
	pub punctuation: String,
	/// ANSI color for diff inserted lines.
	pub inserted:    Option<String>,
	/// ANSI color for diff deleted lines.
	pub deleted:     Option<String>,
}

impl HighlightColors {
	/// Borrowed view for the highlighter. An absent diff colour is an empty
	/// string, which the highlighter reads as "leave this category uncoloured".
	fn palette(&self) -> Palette<'_> {
		Palette {
			comment:     &self.comment,
			keyword:     &self.keyword,
			function:    &self.function,
			variable:    &self.variable,
			string:      &self.string,
			number:      &self.number,
			type_name:   &self.r#type,
			operator:    &self.operator,
			punctuation: &self.punctuation,
			inserted:    self.inserted.as_deref().unwrap_or(""),
			deleted:     self.deleted.as_deref().unwrap_or(""),
		}
	}
}

/// Highlight code and return ANSI-colored lines.
///
/// # Arguments
/// * `code` - The source code to highlight
/// * `lang` - Language identifier (e.g., "rust", "typescript", "python")
/// * `colors` - Theme colors as ANSI escape sequences
///
/// # Returns
/// Highlighted code with ANSI color codes, or the original code if highlighting
/// fails.
#[napi]
pub fn highlight_code(code: String, lang: Option<String>, colors: HighlightColors) -> String {
	veyyon_highlight::highlight(&code, lang.as_deref(), &colors.palette())
}

/// Check if a language is supported for highlighting.
/// Returns true if the language has either direct support or a fallback
/// mapping.
#[napi]
pub fn supports_language(lang: String) -> bool {
	veyyon_highlight::supports_language(&lang)
}

/// Get list of supported languages.
#[napi]
pub fn get_supported_languages() -> Vec<String> {
	veyyon_highlight::supported_languages()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn test_colors() -> HighlightColors {
		HighlightColors {
			comment:     "<c>".to_string(),
			keyword:     "<k>".to_string(),
			function:    "<f>".to_string(),
			variable:    "<v>".to_string(),
			string:      "<s>".to_string(),
			number:      "<n>".to_string(),
			r#type:      "<t>".to_string(),
			operator:    "<o>".to_string(),
			punctuation: "<p>".to_string(),
			inserted:    None,
			deleted:     None,
		}
	}

	#[test]
	fn highlights_nix_vendored_syntax() {
		assert!(get_supported_languages().contains(&"Nix".to_string()));
		assert!(supports_language("nix".to_string()));

		let out = highlight_code(
			"{ pkgs ? import <nixpkgs> {} }:\nlet message = \"hello\"; in pkgs.writeText \"msg\" \
			 message # greeting\n"
				.to_string(),
			Some("nix".to_string()),
			test_colors(),
		);
		assert!(out.contains("<k>let"));
		assert!(out.contains("<s>hello"));
		assert!(out.contains("<c># greeting"));
	}

	#[test]
	fn highlights_mermaid_vendored_syntax() {
		assert!(get_supported_languages().contains(&"Mermaid".to_string()));
		assert!(supports_language("mermaid".to_string()));
		assert!(supports_language("mmd".to_string()));

		let out = highlight_code(
			"graph TD\n  A[\"Start\"] --> B\n  %% note\n".to_string(),
			Some("mermaid".to_string()),
			test_colors(),
		);
		assert!(out.contains("<k>graph"));
		assert!(out.contains("<s>Start"));
		assert!(out.contains("<k>-->"));
		assert!(out.contains("<c> note"));
	}
}
