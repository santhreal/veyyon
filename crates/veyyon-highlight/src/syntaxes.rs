//! The syntax set every highlight pass parses against.
//!
//! The set is assembled by `build.rs` and embedded as a single dump, so the
//! process deserialises it and nothing else. Assembling it here instead meant
//! `into_builder()`, which clones every context of every syntax, and then
//! `build()`, which relinks all of them, to fold three vendored syntaxes into a
//! set that is 1.4MB when merely deserialised. That copy cost 12.5MB of
//! resident heap and glibc returned 10.2MB of it to no one.
//!
//! `examples/rss-split.rs` measures the shape this replaced.

use std::sync::LazyLock;

use syntect::parsing::{SyntaxReference, SyntaxSet};

/// syntect's newline-aware defaults plus the vendored Julia, Nix and Mermaid
/// syntaxes, linked at build time. `build.rs` fails the build if a vendored
/// syntax is missing or unreachable, so an absence cannot reach here and
/// degrade to uncoloured output.
const SYNTAX_DUMP: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/syntaxes.packdump"));

static SYNTAX_SET: LazyLock<SyntaxSet> = LazyLock::new(|| syntect::dumps::from_binary(SYNTAX_DUMP));

/// The process-wide set.
pub fn syntax_set() -> &'static SyntaxSet {
	&SYNTAX_SET
}

/// Aliases for languages syntect either does not bundle or names differently
/// from the token a caller passes. Consulted only after a direct token and
/// extension lookup both miss, so an alias never shadows a real syntax.
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

/// The syntax name an alias points at.
#[inline]
fn find_alias(lang: &str) -> Option<&'static str> {
	LANG_ALIASES
		.iter()
		.find(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
		.map(|(_, target)| *target)
}

/// Whether `lang` appears in the alias table at all.
#[inline]
pub fn is_known_alias(lang: &str) -> bool {
	LANG_ALIASES
		.iter()
		.any(|(aliases, _)| aliases.iter().any(|a| lang.eq_ignore_ascii_case(a)))
}

/// Resolve a caller's language token to a syntax.
///
/// Token, then extension, then the alias table. Any syntax in `ss` is
/// reachable through the first two, so the alias table only adds names, it
/// never removes reach.
pub fn find_syntax<'a>(ss: &'a SyntaxSet, lang: &str) -> Option<&'a SyntaxReference> {
	if let Some(syn) = ss.find_syntax_by_token(lang) {
		return Some(syn);
	}
	if let Some(syn) = ss.find_syntax_by_extension(lang) {
		return Some(syn);
	}
	let alias = find_alias(lang)?;
	ss.find_syntax_by_name(alias)
		.or_else(|| ss.find_syntax_by_token(alias))
}
