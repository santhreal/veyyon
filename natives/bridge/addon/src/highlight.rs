//! Syntax highlighting using syntect.
//!
//! Provides ANSI-colored output for code blocks. Takes theme colors as input
//! and maps syntect scopes to 11 semantic categories:
//! - comment, keyword, function, variable, string, number, type, operator,
//!   punctuation, inserted, deleted

use std::{cell::RefCell, collections::HashMap, os::raw::c_ulong, sync::LazyLock};

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

/// Oniguruma's retry budget for one match attempt and for one search across
/// all of its start positions. A match or search that exceeds it fails, and
/// syntect reads the failure as no match. Oniguruma's defaults are 10,000,000
/// per attempt and no limit per search. Markdown's table-row and emphasis
/// patterns repeat a group inside a repeated group, and YAML's implicit-key
/// lookahead scans to the line end from every start position, so at those
/// defaults a two-line Markdown source takes up to 77 ms and an 8,000-character
/// YAML line with a colon in its value 450 ms. At 1,000,000, the backtrack
/// limit fancy-regex applied to one search, 25,237 sources from session
/// transcripts, this repository and long-line probes parse to the scopes
/// fancy-regex produced, in 38% of its time, and the slowest takes 58 ms
/// against 200 ms.
const REGEX_RETRY_LIMIT: c_ulong = 1_000_000;

/// Set Oniguruma's process-wide match and search retry limits to
/// [`REGEX_RETRY_LIMIT`].
///
/// The limits are C globals that every match and search reads when it starts,
/// so they also bound the `find` builtin's `-name` and `-regex` matching. Call
/// this once from module initialisation, before any thread can start a match.
pub fn bound_regex_retries() {
	// SAFETY: each setter writes one C global and has no other effect. The
	// caller runs before any thread that could read them concurrently exists.
	unsafe {
		onig_sys::onig_set_retry_limit_in_match(REGEX_RETRY_LIMIT);
		onig_sys::onig_set_retry_limit_in_search(REGEX_RETRY_LIMIT);
	}
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

/// The ANSI colour of each token class, indexed by the class
/// `scope_to_color_index` returns. An empty entry leaves that class uncoloured.
type Palette = [String; 11];

fn palette_of(colors: HighlightColors) -> Palette {
	[
		colors.comment,                      // 0
		colors.keyword,                      // 1
		colors.function,                     // 2
		colors.variable,                     // 3
		colors.string,                       // 4
		colors.number,                       // 5
		colors.r#type,                       // 6
		colors.operator,                     // 7
		colors.punctuation,                  // 8
		colors.inserted.unwrap_or_default(), // 9
		colors.deleted.unwrap_or_default(),  // 10
	]
}

/// The syntax for a language name, or plain text when none matches.
fn syntax_for<'a>(ss: &'a SyntaxSet, lang: Option<&str>) -> &'a SyntaxReference {
	lang
		.and_then(|l| find_syntax(ss, l))
		.unwrap_or_else(|| ss.find_syntax_plain_text())
}

/// Append `text` to `out` in the colour the innermost classified scope of
/// `scope_stack` maps to.
#[inline]
fn push_colored(out: &mut String, text: &str, scope_stack: &ScopeStack, palette: &Palette) {
	let color_idx = scope_to_color_index(scope_stack);
	match palette.get(color_idx) {
		Some(color) if !color.is_empty() => {
			out.push_str(color);
			out.push_str(text);
			out.push_str("\x1b[39m");
		},
		_ => out.push_str(text),
	}
}

/// Highlight the lines of `text` into `out`, starting from and advancing
/// `parse_state` and `scope_stack`.
///
/// Syntect parses each line from the state the line before it left, so the
/// colours of a line depend on no line after it: highlighting a source in two
/// runs split at a line end writes the same bytes as highlighting it in one.
fn highlight_into(
	text: &str,
	ss: &SyntaxSet,
	parse_state: &mut ParseState,
	scope_stack: &mut ScopeStack,
	palette: &Palette,
	out: &mut String,
) {
	for line in syntect::util::LinesWithEndings::from(text) {
		let Ok(ops) = parse_state.parse_line(line, ss) else {
			// Parse error - append unhighlighted line and continue
			out.push_str(line);
			continue;
		};

		let mut prev_end = 0;
		for (offset, op) in ops {
			let offset = offset.min(line.len());

			// Output text BEFORE this operation using current scope
			if offset > prev_end {
				push_colored(out, &line[prev_end..offset], scope_stack, palette);
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
			push_colored(out, &line[prev_end..], scope_stack, palette);
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
	let palette = palette_of(colors);
	let ss = get_syntax_set();
	let mut parse_state = ParseState::new(syntax_for(ss, lang.as_deref()));
	let mut scope_stack = ScopeStack::new();
	let mut result = String::with_capacity(code.len() * 2);
	highlight_into(&code, ss, &mut parse_state, &mut scope_stack, &palette, &mut result);
	result
}

/// A highlighter that keeps its place in one source.
///
/// A source that grows at its end, such as a file a tool call is still
/// streaming, is highlighted once per line: `advance` colours the lines that
/// arrived and moves the parser past them, and `peek` colours the unfinished
/// last line without moving it. The concatenated output of every `advance`
/// followed by one `peek` is byte-identical to `highlightCode` over the whole
/// source, provided each `advance` ends at a line end.
#[napi]
pub struct CodeHighlighter {
	parse_state: ParseState,
	scope_stack: ScopeStack,
	palette:     Palette,
}

#[napi]
impl CodeHighlighter {
	#[napi(constructor)]
	pub fn new(lang: Option<String>, colors: HighlightColors) -> Self {
		Self {
			parse_state: ParseState::new(syntax_for(get_syntax_set(), lang.as_deref())),
			scope_stack: ScopeStack::new(),
			palette:     palette_of(colors),
		}
	}

	/// Highlight `text` from where the last `advance` ended and move the parser
	/// past it. `text` ends at a line end, or the next call continues a line
	/// the parser already closed.
	#[napi]
	pub fn advance(&mut self, text: String) -> String {
		let mut out = String::with_capacity(text.len() * 2);
		highlight_into(
			&text,
			get_syntax_set(),
			&mut self.parse_state,
			&mut self.scope_stack,
			&self.palette,
			&mut out,
		);
		out
	}

	/// Highlight `text` from where the last `advance` ended, leaving the parser
	/// where it was.
	#[napi]
	pub fn peek(&self, text: String) -> String {
		let mut parse_state = self.parse_state.clone();
		let mut scope_stack = self.scope_stack.clone();
		let mut out = String::with_capacity(text.len() * 2);
		highlight_into(
			&text,
			get_syntax_set(),
			&mut parse_state,
			&mut scope_stack,
			&self.palette,
			&mut out,
		);
		out
	}
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

	/// Stream `source` one character at a time, advancing over each line as it
	/// completes and peeking at the unfinished one, and require every prefix to
	/// come out byte-identical to `highlight_code` over that prefix.
	fn assert_streams_like_one_shot(lang: &str, source: &str) {
		let mut stream = CodeHighlighter::new(Some(lang.to_string()), test_colors());
		let mut advanced = String::new();
		let mut settled = 0;
		let ends = source
			.char_indices()
			.map(|(index, _)| index)
			.skip(1)
			.chain(std::iter::once(source.len()));
		for end in ends {
			let prefix = &source[..end];
			let line_end = prefix.rfind('\n').map_or(0, |index| index + 1);
			if line_end > settled {
				advanced.push_str(&stream.advance(prefix[settled..line_end].to_string()));
				settled = line_end;
			}
			let streamed = format!("{advanced}{}", stream.peek(prefix[settled..].to_string()));
			let one_shot = highlight_code(prefix.to_string(), Some(lang.to_string()), test_colors());
			assert_eq!(streamed, one_shot, "{lang}: prefix of {end} bytes");
		}
	}

	#[test]
	fn a_streamed_source_is_coloured_as_the_whole_source_is() {
		// Each source opens a construct on one line and closes it on a later one, so
		// a stream that dropped the parser state or the scope stack between lines,
		// or let a peek move either, colours the lines after it differently.
		assert_streams_like_one_shot(
			"ts",
			"/* a block\n   comment */\nconst greeting = `hello\n${name}`;\nfunction f(x: number) \
			 {\n\treturn x * 2; // done\n}\n",
		);
		assert_streams_like_one_shot(
			"python",
			"def f():\n    \"\"\"A docstring\n    across lines\"\"\"\n    return 'x'  # tail\n",
		);
		assert_streams_like_one_shot(
			"rust",
			"/* outer /* inner */\n still */\nlet s = r#\"raw\nline\"#;\nfn main() {}\n",
		);
		assert_streams_like_one_shot(
			"diff",
			"--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n",
		);
		assert_streams_like_one_shot(
			"bash",
			"cat <<EOF\nnot a $command\nEOF\necho \"multi\nline\" | wc -l\n",
		);
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
