//! Build the syntax set once, here, instead of once per process at startup.
//!
//! Assembling the set at runtime meant
//! `load_defaults_newlines().into_builder()` — which clones every context of
//! every syntax — followed by `build()`, which relinks all of them, purely to
//! fold three vendored syntaxes in. That copy cost 12.5MB of resident heap,
//! 10.2MB of which glibc never returned to the kernel, for a set that is 1.4MB
//! when merely deserialised. See `examples/rss-split.rs`.
//!
//! The dump this writes is the same linked set the runtime used to assemble, so
//! loading it is one `from_binary` and the process never constructs a builder.

use std::{env, fs, path::PathBuf};

use syntect::{
	dumps::dump_binary,
	parsing::{SyntaxDefinition, SyntaxSet},
};

/// Vendored syntaxes syntect ships none of, by display name and source path.
/// The name is only for the failure message; the set records its own.
const EXTRA_SYNTAXES: &[(&str, &str)] = &[
	("Julia", "src/syntaxes/Julia.sublime-syntax"),
	("Nix", "src/syntaxes/Nix.sublime-syntax"),
	("Mermaid", "src/syntaxes/Mermaid.sublime-syntax"),
];

fn main() {
	println!("cargo::rerun-if-changed=build.rs");

	let mut builder = SyntaxSet::load_defaults_newlines().into_builder();

	for (name, path) in EXTRA_SYNTAXES {
		println!("cargo::rerun-if-changed={path}");
		let src = fs::read_to_string(path)
			.unwrap_or_else(|e| panic!("vendored syntax {name} at {path} is unreadable: {e}"));
		// A vendored syntax that does not parse is a build failure rather than a
		// skip. Skipping is what made a missing language look like an
		// unsupported one at runtime: `with_escape` references fall back to
		// Plain Text silently, so the absence showed up as uncoloured output
		// rather than as an error.
		let def = SyntaxDefinition::load_from_str(&src, true, None)
			.unwrap_or_else(|e| panic!("vendored syntax {name} at {path} does not parse: {e}"));
		builder.add(def);
	}

	let set = builder.build();

	// Every vendored syntax must be findable by name in the built set. `add`
	// takes a definition whose own `name` field drives lookup, so a source
	// whose name does not match what callers ask for would parse, link, and
	// then be unreachable.
	for (name, path) in EXTRA_SYNTAXES {
		assert!(
			set.find_syntax_by_name(name).is_some(),
			"vendored syntax {name} at {path} parsed but is not reachable as {name:?} in the built \
			 set",
		);
	}

	let out = PathBuf::from(env::var_os("OUT_DIR").expect("cargo always sets OUT_DIR"))
		.join("syntaxes.packdump");
	fs::write(&out, dump_binary(&set))
		.unwrap_or_else(|e| panic!("cannot write the syntax dump to {}: {e}", out.display()));
}
