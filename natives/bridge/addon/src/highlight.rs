//! Syntax highlighting using syntect.
//!
//! Provides ANSI-colored output for code blocks. Takes theme colors as input
//! and maps syntect scopes to 11 semantic categories:
//! - comment, keyword, function, variable, string, number, type, operator,
//!   punctuation, inserted, deleted

use std::{cell::RefCell, collections::HashMap, sync::LazyLock};

use napi_derive::napi;
use syntect::parsing::{
	ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxDefinition, SyntaxReference, SyntaxSet,
};

static SYNTAX_SET: LazyLock<SyntaxSet> = LazyLock::new(build_syntax_set);
static COMPILED_RULES: LazyLock<Vec<(Scope, usize)>> = LazyLock::new(|| {
	SCOPE_RULES
		.iter()
		.flat_map(|(selectors, idx)| {
			selectors
				.iter()
				.map(move |sel| (Scope::new(sel).unwrap(), *idx))
		})
		.collect()
});

// Thread-local cache for scope -> color index lookups
thread_local! {
	static SCOPE_COLOR_CACHE: RefCell<HashMap<Scope, usize>> = RefCell::new(HashMap::with_capacity(256));
}

/// Syntaxes bundled in addition to syntect's defaults: syntect ships none of
/// these, so we vendor their `.sublime-syntax` sources and fold them into the
/// set.
const EXTRA_SYNTAXES: &[&str] = &[
	include_str!("syntaxes/Julia.sublime-syntax"),
	include_str!("syntaxes/Nix.sublime-syntax"),
	include_str!("syntaxes/Mermaid.sublime-syntax"),
];

fn get_syntax_set() -> &'static SyntaxSet {
	&SYNTAX_SET
}

/// Load syntect's newline-aware defaults and add the vendored extra syntaxes.
/// A vendored syntax that fails to parse is skipped rather than breaking all
/// highlighting; the bundled-language tests guard against silent absence.
fn build_syntax_set() -> SyntaxSet {
	let mut builder = SyntaxSet::load_defaults_newlines().into_builder();
	for src in EXTRA_SYNTAXES {
		if let Ok(def) = SyntaxDefinition::load_from_str(src, true, None) {
			builder.add(def);
		}
	}
	builder.build()
}

const SCOPE_RULES: &[(&[&str], usize)] = &[
	(&["comment"], 0),
	(&["markup.inserted"], 9),
	(&["markup.deleted"], 10),
	(&["meta.diff.header", "meta.diff.range"], 1),
	(&["string", "constant.character", "meta.string"], 4),
	(&["constant.numeric", "constant.integer"], 5),
	(&["keyword", "storage.type", "storage.modifier"], 1),
	(&["entity.name.function", "support.function", "meta.function-call", "variable.function"], 2),
	(
		&[
			"entity.name.type",
			"support.type",
			"support.class",
			"entity.name.class",
			"entity.name.struct",
			"entity.name.enum",
			"entity.name.interface",
			"entity.name.trait",
		],
		6,
	),
	(&["keyword.operator", "punctuation.accessor"], 7),
	(&["punctuation"], 8),
	(&["variable", "entity.name", "meta.path"], 3),
	(&["constant"], 5),
];

fn get_compiled_scope_rules() -> &'static [(Scope, usize)] {
	&COMPILED_RULES
}

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

/// Language alias mappings: (aliases, target syntax name).
/// Used for languages not in syntect's default set or with non-standard names.
const LANG_ALIASES: &[(&[&str], &str)] = &[
	(&["ts", "tsx", "typescript", "js", "jsx", "javascript", "mjs", "cjs"], "JavaScript"),
	(&["py", "python"], "Python"),
	(&["rb", "ruby"], "Ruby"),
	(&["jl", "julia"], "Julia"),
	(&["nix"], "Nix"),
	(&["mermaid", "mmd"], "Mermaid"),
	(&["rs", "rust"], "Rust"),
	(&["go", "golang"], "Go"),
	(&["java"], "Java"),
	(&["kt", "kotlin"], "Java"),
	(&["swift"], "Objective-C"),
	(&["c", "h"], "C"),
	(&["cpp", "cc", "cxx", "c++", "hpp", "hxx", "hh"], "C++"),
	(&["cs", "csharp"], "C#"),
	(&["php"], "PHP"),
	(&["sh", "bash", "zsh", "shell"], "Bash"),
	(&["ps1", "powershell"], "PowerShell"),
	(&["html", "htm", "astro", "vue", "svelte"], "HTML"),
	(&["css"], "CSS"),
	(&["scss"], "SCSS"),
	(&["sass"], "Sass"),
	(&["less"], "LESS"),
	(&["json"], "JSON"),
	(&["yaml", "yml"], "YAML"),
	(&["toml"], "TOML"),
	(&["xml"], "XML"),
	(&["md", "markdown"], "Markdown"),
	(&["sql"], "SQL"),
	(&["lua"], "Lua"),
	(&["r"], "R"),
	(&["scala"], "Scala"),
	(&["clj", "clojure"], "Clojure"),
	(&["el", "elisp", "emacs-lisp", "emacslisp"], "Lisp"),
	(&["ex", "exs", "elixir"], "Ruby"),
	(&["erl", "erlang"], "Erlang"),
	(&["hs", "haskell"], "Haskell"),
	(&["ml", "ocaml"], "OCaml"),
	(&["vim"], "VimL"),
	(&["graphql", "gql"], "GraphQL"),
	(&["proto", "protobuf"], "Protocol Buffers"),
	(&["tf", "hcl", "terraform"], "Terraform"),
	(&["dockerfile", "docker", "containerfile"], "Dockerfile"),
	(&["makefile", "make", "just", "justfile"], "Makefile"),
	(&["cmake", "cmakelists"], "CMake"),
	(&["ini", "cfg", "conf", "config", "properties"], "INI"),
	(&["diff", "patch"], "Diff"),
	(&["gitignore", "gitattributes", "gitmodules"], "Git Ignore"),
];

/// Find syntax name from alias table using case-insensitive comparison.
#[inline]
fn find_alias(lang: &str) -> Option<&'static str> {
	LANG_ALIASES
		.iter()
		.find(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
		.map(|(_, target)| *target)
}

/// Check if language is in the alias table.
#[inline]
fn is_known_alias(lang: &str) -> bool {
	LANG_ALIASES
		.iter()
		.any(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
}

/// Compute the color index for a single scope (uncached).
#[inline]
fn compute_scope_color(s: Scope) -> usize {
	for (scope, idx) in get_compiled_scope_rules() {
		if scope.is_prefix_of(s) {
			return *idx;
		}
	}
	usize::MAX
}

/// Determine the semantic color category from a scope stack.
/// Uses per-scope caching to avoid repeated prefix checks.
#[inline]
fn scope_to_color_index(scope: &ScopeStack) -> usize {
	SCOPE_COLOR_CACHE.with(|cache| {
		let mut cache = cache.borrow_mut();

		// Walk from innermost to outermost scope
		for s in scope.as_slice().iter().rev() {
			let color_idx = *cache.entry(*s).or_insert_with(|| compute_scope_color(*s));
			if color_idx != usize::MAX {
				return color_idx;
			}
		}

		usize::MAX
	})
}

/// Find the appropriate syntax for a language name.
fn find_syntax<'a>(ss: &'a SyntaxSet, lang: &str) -> Option<&'a SyntaxReference> {
	// Direct name/token match (syntect APIs are case-insensitive)
	if let Some(syn) = ss.find_syntax_by_token(lang) {
		return Some(syn);
	}

	// Extension-based match
	if let Some(syn) = ss.find_syntax_by_extension(lang) {
		return Some(syn);
	}

	// Alias lookup for languages not in syntect's default set
	let alias = find_alias(lang)?;

	ss.find_syntax_by_name(alias)
		.or_else(|| ss.find_syntax_by_token(alias))
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
	let inserted = colors.inserted.as_deref().unwrap_or("");
	let deleted = colors.deleted.as_deref().unwrap_or("");

	// Color palette as array for quick indexing
	let palette = [
		colors.comment.as_str(),     // 0
		colors.keyword.as_str(),     // 1
		colors.function.as_str(),    // 2
		colors.variable.as_str(),    // 3
		colors.string.as_str(),      // 4
		colors.number.as_str(),      // 5
		colors.r#type.as_str(),      // 6
		colors.operator.as_str(),    // 7
		colors.punctuation.as_str(), // 8
		inserted,                    // 9
		deleted,                     // 10
	];

	let ss = get_syntax_set();

	// Find syntax for the language
	let syntax = match &lang {
		Some(l) => find_syntax(ss, l),
		None => None,
	}
	.unwrap_or_else(|| ss.find_syntax_plain_text());

	let mut parse_state = ParseState::new(syntax);
	let mut scope_stack = ScopeStack::new();
	let mut result = String::with_capacity(code.len() * 2);

	for line in syntect::util::LinesWithEndings::from(code.as_str()) {
		let Ok(ops) = parse_state.parse_line(line, ss) else {
			// Parse error - append unhighlighted line and continue
			result.push_str(line);
			continue;
		};

		let mut prev_end = 0;
		for (offset, op) in ops {
			let offset = offset.min(line.len());

			// Output text BEFORE this operation using current scope
			if offset > prev_end {
				let text = &line[prev_end..offset];
				let color_idx = scope_to_color_index(&scope_stack);

				if color_idx < palette.len() && !palette[color_idx].is_empty() {
					result.push_str(palette[color_idx]);
					result.push_str(text);
					result.push_str("\x1b[39m");
				} else {
					result.push_str(text);
				}
			}
			prev_end = offset;

			// Now apply scope operation for NEXT segment
			match op {
				ScopeStackOp::Push(scope) => {
					scope_stack.push(scope);
				},
				ScopeStackOp::Pop(count) => {
					for _ in 0..count {
						scope_stack.pop();
					}
				},
				ScopeStackOp::Restore | ScopeStackOp::Clear(_) | ScopeStackOp::Noop => {},
			}
		}

		// Output remaining text with current scope
		if prev_end < line.len() {
			let text = &line[prev_end..];
			let color_idx = scope_to_color_index(&scope_stack);

			if color_idx < palette.len() && !palette[color_idx].is_empty() {
				result.push_str(palette[color_idx]);
				result.push_str(text);
				result.push_str("\x1b[39m");
			} else {
				result.push_str(text);
			}
		}
	}

	result
}

/// Check if a language is supported for highlighting.
/// Returns true if the language has either direct support or a fallback
/// mapping.
#[napi]
pub fn supports_language(lang: String) -> bool {
	if is_known_alias(&lang) {
		return true;
	}

	// Fall back to direct syntax lookup
	let ss = get_syntax_set();
	find_syntax(ss, &lang).is_some()
}

/// Get list of supported languages.
#[napi]
pub fn get_supported_languages() -> Vec<String> {
	let ss = get_syntax_set();
	ss.syntaxes().iter().map(|s| s.name.clone()).collect()
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

	#[test]
	fn test_scope_rules_token_classes_coverage() {
		let rules = get_compiled_scope_rules();
		assert!(!rules.is_empty(), "compiled scope rules must not be empty");

		// Verify every rule maps to a valid token class index (0..=10)
		for (scope, idx) in rules {
			assert!(*idx <= 10, "invalid color index {idx} for scope {scope:?}");
		}

		// Verify all 11 semantic token classes (0..=10) are represented
		let mut covered_indices = std::collections::BTreeSet::new();
		for (_, idx) in rules {
			covered_indices.insert(*idx);
		}
		assert_eq!(
			covered_indices.len(),
			11, /* 0..=10 (comment, keyword, function, variable, string, number, type, operator,
			     * punctuation, inserted, deleted) */
			"must cover all token class indices"
		);

		assert_eq!(compute_scope_color(Scope::new("keyword.operator.assignment").unwrap()), 1);
		assert_eq!(compute_scope_color(Scope::new("punctuation.accessor.dot").unwrap()), 7);
		assert_eq!(compute_scope_color(Scope::new("comment.line").unwrap()), 0);
		assert_eq!(compute_scope_color(Scope::new("markup.inserted.diff").unwrap()), 9);
		assert_eq!(compute_scope_color(Scope::new("markup.deleted.diff").unwrap()), 10);
		assert_eq!(compute_scope_color(Scope::new("meta.diff.header").unwrap()), 1);
		assert_eq!(compute_scope_color(Scope::new("string.quoted.double").unwrap()), 4);
		assert_eq!(compute_scope_color(Scope::new("constant.numeric.integer").unwrap()), 5);
		assert_eq!(compute_scope_color(Scope::new("keyword.control").unwrap()), 1);
		assert_eq!(compute_scope_color(Scope::new("entity.name.function.rust").unwrap()), 2);
		assert_eq!(compute_scope_color(Scope::new("entity.name.type.rust").unwrap()), 6);
		assert_eq!(compute_scope_color(Scope::new("punctuation.definition.block").unwrap()), 8);
		assert_eq!(compute_scope_color(Scope::new("variable.other.rust").unwrap()), 3);
		assert_eq!(compute_scope_color(Scope::new("constant.language").unwrap()), 5);

		// Verify unmatched scope returns usize::MAX
		let unmatched = Scope::new("completely.unknown.token.class").unwrap();
		assert_eq!(compute_scope_color(unmatched), usize::MAX);
	}
}
