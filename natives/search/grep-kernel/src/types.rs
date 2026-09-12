use std::{ffi::OsString, io::Write, path::Path};

use ignore::{
	Match,
	gitignore::{Gitignore, GitignoreBuilder},
	types::{Types, TypesBuilder},
};

#[derive(Clone, Debug)]
pub enum TypeFilter {
	Known { exts: &'static [&'static str], names: &'static [&'static str] },
	Custom(String),
}

impl TypeFilter {
	#[must_use]
	pub fn match_ext(&self, ext: &str) -> bool {
		match self {
			Self::Known { exts, .. } => exts.iter().any(|e| ext.eq_ignore_ascii_case(e)),
			Self::Custom(custom_ext) => ext.eq_ignore_ascii_case(custom_ext),
		}
	}

	#[must_use]
	pub fn match_name(&self, name: &str) -> bool {
		match self {
			Self::Known { names, .. } => names.iter().any(|n| name.eq_ignore_ascii_case(n)),
			Self::Custom(ext) => ext.eq_ignore_ascii_case(name),
		}
	}
}

pub fn resolve_type_filter(type_name: Option<&str>) -> Option<TypeFilter> {
	let normalized = type_name
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(|value| value.trim_start_matches('.').to_lowercase())?;

	let (exts, names): (&[&str], &[&str]) = match normalized.as_str() {
		"js" | "javascript" => (&["js", "jsx", "mjs", "cjs"], &[]),
		"ts" | "typescript" => (&["ts", "tsx", "mts", "cts"], &[]),
		"json" => (&["json", "jsonc", "json5"], &[]),
		"yaml" | "yml" => (&["yaml", "yml"], &[]),
		"toml" => (&["toml"], &[]),
		"md" | "markdown" => (&["md", "markdown", "mdx"], &[]),
		"py" | "python" => (&["py", "pyi"], &[]),
		"rs" | "rust" => (&["rs"], &[]),
		"go" => (&["go"], &[]),
		"java" => (&["java"], &[]),
		"kt" | "kotlin" => (&["kt", "kts"], &[]),
		"c" => (&["c", "h"], &[]),
		"cpp" | "cxx" => (&["cpp", "cc", "cxx", "hpp", "hxx", "hh"], &[]),
		"cs" | "csharp" => (&["cs", "csx"], &[]),
		"php" => (&["php", "phtml"], &[]),
		"rb" | "ruby" => (&["rb", "rake", "gemspec"], &[]),
		"sh" | "bash" => (&["sh", "bash", "zsh"], &[]),
		"zsh" => (&["zsh"], &[]),
		"fish" => (&["fish"], &[]),
		"html" => (&["html", "htm"], &[]),
		"css" => (&["css"], &[]),
		"scss" => (&["scss"], &[]),
		"sass" => (&["sass"], &[]),
		"less" => (&["less"], &[]),
		"xml" => (&["xml"], &[]),
		"docker" | "dockerfile" => (&[], &["dockerfile"]),
		"make" | "makefile" => (&[], &["makefile"]),
		_ => {
			return Some(TypeFilter::Custom(normalized));
		},
	};

	Some(TypeFilter::Known { exts, names })
}

pub fn matches_type_filter(path: &Path, filter: &TypeFilter) -> bool {
	let base_name = path
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or("");
	if filter.match_name(base_name) {
		return true;
	}
	let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
	if ext.is_empty() {
		return false;
	}
	filter.match_ext(ext)
}

pub fn matches_type_filter_str(path: &str, filter: &TypeFilter) -> bool {
	let base = path.rsplit('/').next().unwrap_or(path);
	if filter.match_name(base) {
		return true;
	}
	let ext = base.rsplit_once('.').map_or("", |(_, ext)| ext);
	if ext.is_empty() {
		return false;
	}
	filter.match_ext(ext)
}

pub fn add_type_definitions(
	builder: &mut TypesBuilder,
	type_clears: &[String],
	type_adds: &[String],
) -> Result<(), String> {
	for name in type_clears {
		builder.clear(name);
	}
	for def in type_adds {
		builder.add_def(def).map_err(|err| err.to_string())?;
	}
	Ok(())
}

pub fn type_builder(
	type_clears: &[String],
	type_adds: &[String],
	types: &[String],
	type_nots: &[String],
) -> Result<TypesBuilder, String> {
	let mut builder = TypesBuilder::new();
	builder.add_defaults();
	add_type_definitions(&mut builder, type_clears, type_adds)?;
	for name in types {
		builder.select(name);
	}
	for name in type_nots {
		builder.negate(name);
	}
	Ok(builder)
}

pub fn print_type_list<W: Write>(
	type_clears: &[String],
	type_adds: &[String],
	types: &[String],
	type_nots: &[String],
	out: &mut W,
) -> Result<(), String> {
	let builder = type_builder(type_clears, type_adds, types, type_nots)?;
	for def in builder.definitions() {
		write!(out, "{}: ", def.name()).map_err(|err| err.to_string())?;
		for (idx, glob) in def.globs().iter().enumerate() {
			if idx > 0 {
				out.write_all(b", ").map_err(|err| err.to_string())?;
			}
			out.write_all(glob.as_bytes())
				.map_err(|err| err.to_string())?;
		}
		out.write_all(b"\n").map_err(|err| err.to_string())?;
	}
	Ok(())
}

pub struct RgWalk {
	pub request: veyyon_walker::WalkRequest,
	pub filters: PathFilters,
}

pub struct PathFilters {
	pub overrides:    Option<veyyon_walker::WalkOverrides>,
	pub explicit:     Option<Gitignore>,
	pub types:        Option<Types>,
	pub max_filesize: Option<u64>,
}

impl PathFilters {
	#[must_use]
	pub fn includes(
		&self,
		path: &Path,
		file_type: veyyon_walker::FileType,
		size: Option<f64>,
	) -> bool {
		use veyyon_walker::WalkOverrideVerdict as Verdict;

		let is_dir = file_type == veyyon_walker::FileType::Dir;
		let override_verdict = self
			.overrides
			.as_ref()
			.map_or(Verdict::Undecided, |overrides| overrides.verdict(path, is_dir));
		if override_verdict == Verdict::Exclude {
			return false;
		}
		let explicitly_included = override_verdict == Verdict::Include;
		if !explicitly_included
			&& self
				.explicit
				.as_ref()
				.is_some_and(|ignore| matches!(ignore.matched(path, is_dir), Match::Ignore(_)))
		{
			return false;
		}
		if file_type != veyyon_walker::FileType::File {
			return true;
		}
		if !explicitly_included
			&& self
				.types
				.as_ref()
				.is_some_and(|types| matches!(types.matched(path, false), Match::Ignore(_)))
		{
			return false;
		}
		if let Some(limit) = self.max_filesize {
			let size = size.or_else(|| std::fs::metadata(path).ok().map(|meta| meta.len() as f64));
			if size.is_some_and(|size| size > limit as f64) {
				return false;
			}
		}
		true
	}
}

/// Helper parameters for building path filters and directory traversal.
pub struct WalkFilterParams<'a> {
	pub max_filesize:          Option<u64>,
	pub globs:                 &'a [String],
	pub iglobs:                &'a [String],
	pub glob_case_insensitive: bool,
	pub ignore_files:          &'a [OsString],
	pub type_clears:           &'a [String],
	pub type_adds:             &'a [String],
	pub types:                 &'a [String],
	pub type_nots:             &'a [String],
	pub no_ignore:             bool,
	pub unrestricted:          u8,
	pub hidden:                bool,
	pub no_ignore_dot:         bool,
	pub no_ignore_vcs:         bool,
	pub no_ignore_exclude:     bool,
	pub no_ignore_global:      bool,
	pub no_ignore_parent:      bool,
	pub no_require_git:        bool,
	pub follow:                bool,
	pub max_depth:             Option<usize>,
	pub one_file_system:       bool,
}

pub fn build_path_filters(params: &WalkFilterParams<'_>) -> Result<PathFilters, String> {
	let cwd = veyyon_uutils_ctx::cwd();
	let max_filesize = params.max_filesize;
	let overrides = if params.globs.is_empty() && params.iglobs.is_empty() {
		None
	} else {
		let patterns = params
			.globs
			.iter()
			.map(|glob| veyyon_walker::WalkOverridePattern {
				glob:             glob.clone(),
				case_insensitive: params.glob_case_insensitive,
			})
			.chain(
				params
					.iglobs
					.iter()
					.map(|glob| veyyon_walker::WalkOverridePattern::case_insensitive(glob.clone())),
			);
		Some(veyyon_walker::WalkOverrides::new(&cwd, patterns).map_err(|error| {
			if error.glob.is_empty() {
				error.message
			} else {
				let flag = if params.iglobs.contains(&error.glob) {
					"--iglob"
				} else {
					"--glob"
				};
				format!("{flag} {:?}: {}", error.glob, error.message)
			}
		})?)
	};
	let explicit = if params.ignore_files.is_empty() {
		None
	} else {
		let mut builder = GitignoreBuilder::new(&cwd);
		for path in params.ignore_files {
			let resolved = veyyon_uutils_ctx::resolve(path);
			if let Some(error) = builder.add(&resolved) {
				return Err(format!("{}: {error}", path.to_string_lossy()));
			}
		}
		Some(builder.build().map_err(|error| error.to_string())?)
	};
	let types = if params.types.is_empty() && params.type_nots.is_empty() {
		add_type_definitions(&mut TypesBuilder::new(), params.type_clears, params.type_adds)?;
		None
	} else {
		Some(
			type_builder(params.type_clears, params.type_adds, params.types, params.type_nots)?
				.build()
				.map_err(|error| error.to_string())?,
		)
	};
	Ok(PathFilters { overrides, explicit, types, max_filesize })
}

pub fn build_walk(params: &WalkFilterParams<'_>, root: &Path) -> Result<RgWalk, String> {
	let filters = build_path_filters(params)?;
	let unrestricted_no_ignore = params.unrestricted >= 1;
	let include_hidden = params.hidden || params.unrestricted >= 2;
	let no_ignore = params.no_ignore || unrestricted_no_ignore;
	let order = veyyon_walker::WalkOrder::Unordered;
	let request = veyyon_walker::WalkRequest::new(root)
		.hidden(include_hidden)
		.gitignore(!no_ignore)
		.dot_ignore(!params.no_ignore_dot)
		.vcs_ignore(!params.no_ignore_vcs)
		.exclude_ignore(!params.no_ignore_exclude && !params.no_ignore_vcs)
		.global_ignore(!params.no_ignore_global)
		.parent_ignore(!params.no_ignore_parent)
		.require_git(!params.no_require_git)
		.skip_git(false)
		.skip_node_modules(false)
		.follow_links(veyyon_walker::FollowLinks::from(params.follow))
		.detail(if filters.max_filesize.is_some() {
			veyyon_walker::WalkDetail::Full
		} else {
			veyyon_walker::WalkDetail::Minimal
		})
		.order(order)
		.emit_root(false)
		.depth(1, params.max_depth.unwrap_or(usize::MAX))
		.visit_order(veyyon_walker::VisitOrder::PreOrder)
		.directory_errors(veyyon_walker::DirectoryErrorMode::Visit)
		.same_file_system(params.one_file_system)
		.cache(false);
	let request = match filters.overrides.clone() {
		Some(overrides) => request.overrides(overrides),
		None => request,
	};
	Ok(RgWalk { request, filters })
}
