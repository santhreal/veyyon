use std::{
	ffi::{OsStr, OsString},
	io::{self, Write},
	path::{Path, PathBuf},
	time::Duration,
};

use clap::ValueEnum;
use grep_printer::Stats;

use crate::matcher::RegexEngine;

/// Parse a human-readable size string (e.g. `10M`, `2G`, `500K`) into bytes.
pub fn parse_size(input: &str) -> Result<u64, String> {
	let malformed = || {
		format!(
			"invalid size: invalid format for size '{input}', which should be a non-empty sequence \
			 of digits followed by an optional 'K', 'M' or 'G' suffix"
		)
	};
	let (digits, multiplier) = match input.as_bytes().last() {
		Some(b'K') => (&input[..input.len() - 1], 1024),
		Some(b'M') => (&input[..input.len() - 1], 1024 * 1024),
		Some(b'G') => (&input[..input.len() - 1], 1024 * 1024 * 1024),
		_ => (input, 1),
	};
	if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
		return Err(malformed());
	}
	let value = digits
		.parse::<u64>()
		.map_err(|err| format!("invalid size: invalid integer found in size '{input}': {err}"))?;
	Ok(value.saturating_mul(multiplier))
}

/// Parse a numeric flag value.
pub fn parse_flag_number<T>(input: &str) -> Result<T, String>
where
	T: std::str::FromStr<Err = std::num::ParseIntError>,
{
	input
		.parse::<T>()
		.map_err(|err| format!("value is not a valid number: {err}"))
}

/// Format an unrecognized choice error message in ripgrep's words.
#[must_use]
pub fn unrecognized_choice(value: &str) -> String {
	format!("choice '{value}' is unrecognized")
}

/// Parse regular expression engine choice.
pub fn parse_regex_engine(input: &str) -> Result<RegexEngine, String> {
	match input {
		"default" => Ok(RegexEngine::Default),
		"pcre2" => Ok(RegexEngine::Pcre2),
		"auto" => Ok(RegexEngine::Auto),
		other => Err(format!("unrecognized regex engine '{other}'")),
	}
}

/// Parse color choice.
pub fn parse_color_choice(input: &str) -> Result<String, String> {
	match input {
		"never" | "auto" | "always" | "ansi" => Ok(input.to_string()),
		other => Err(unrecognized_choice(other)),
	}
}

/// What `--generate` can write.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum GenerateKind {
	/// A roff man page.
	Man,
	/// A bash completion script.
	CompleteBash,
	/// A zsh completion script.
	CompleteZsh,
	/// A fish completion script.
	CompleteFish,
	/// A PowerShell completion script.
	CompletePowershell,
}

pub fn parse_generate_kind(input: &str) -> Result<GenerateKind, String> {
	match input {
		"man" => Ok(GenerateKind::Man),
		"complete-bash" => Ok(GenerateKind::CompleteBash),
		"complete-zsh" => Ok(GenerateKind::CompleteZsh),
		"complete-fish" => Ok(GenerateKind::CompleteFish),
		"complete-powershell" => Ok(GenerateKind::CompletePowershell),
		other => Err(unrecognized_choice(other)),
	}
}

pub fn write_generated<W: Write>(
	kind: GenerateKind,
	mut command: clap::Command,
	bin_name: &str,
	out: &mut W,
) -> io::Result<()> {
	if kind == GenerateKind::Man {
		return clap_mangen::Man::new(command).render(out);
	}
	let shell = match kind {
		GenerateKind::CompleteBash => clap_complete::Shell::Bash,
		GenerateKind::CompleteZsh => clap_complete::Shell::Zsh,
		GenerateKind::CompleteFish => clap_complete::Shell::Fish,
		GenerateKind::CompletePowershell => clap_complete::Shell::PowerShell,
		GenerateKind::Man => unreachable!("the man kind returned above"),
	};
	clap_complete::generate(shell, &mut command, bin_name, out);
	Ok(())
}

/// Convert escape sequences in separator flags into bytes.
#[must_use]
pub fn unescape_separator(value: &str) -> Vec<u8> {
	let mut out = Vec::with_capacity(value.len());
	let mut chars = value.chars();
	while let Some(ch) = chars.next() {
		if ch != '\\' {
			let mut buffer = [0_u8; 4];
			out.extend_from_slice(ch.encode_utf8(&mut buffer).as_bytes());
			continue;
		}
		match chars.next() {
			Some('n') => out.push(b'\n'),
			Some('r') => out.push(b'\r'),
			Some('t') => out.push(b'\t'),
			Some('0') => out.push(0),
			Some('\\') => out.push(b'\\'),
			Some('x') => {
				let digits = chars.clone().take(2).collect::<String>();
				match u8::from_str_radix(&digits, 16) {
					Ok(byte) if digits.len() == 2 => {
						out.push(byte);
						chars.next();
						chars.next();
					},
					_ => out.extend_from_slice(b"\\x"),
				}
			},
			Some(other) => {
				out.push(b'\\');
				let mut buffer = [0_u8; 4];
				out.extend_from_slice(other.encode_utf8(&mut buffer).as_bytes());
			},
			None => out.push(b'\\'),
		}
	}
	out
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SortKey {
	Path,
	Modified,
	Accessed,
	Created,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SortSpec {
	pub key:     SortKey,
	pub reverse: bool,
}

pub fn parse_sort_key(value: &str, flag: &str) -> Result<Option<SortKey>, String> {
	match value {
		"none" => Ok(None),
		"path" => Ok(Some(SortKey::Path)),
		"modified" => Ok(Some(SortKey::Modified)),
		"accessed" => Ok(Some(SortKey::Accessed)),
		"created" => Ok(Some(SortKey::Created)),
		other => Err(format!("error parsing flag {flag}: {}", unrecognized_choice(other))),
	}
}

pub fn resolve_sort(
	sort: Option<&str>,
	sortr: Option<&str>,
	sort_files: bool,
) -> Result<Option<SortSpec>, String> {
	if let Some(value) = sortr {
		return Ok(parse_sort_key(value, "--sortr")?.map(|key| SortSpec { key, reverse: true }));
	}
	if let Some(value) = sort {
		return Ok(parse_sort_key(value, "--sort")?.map(|key| SortSpec { key, reverse: false }));
	}
	if sort_files {
		return Ok(Some(SortSpec { key: SortKey::Path, reverse: false }));
	}
	Ok(None)
}

pub fn sort_paths(files: &mut Vec<PathBuf>, spec: SortSpec) {
	match spec.key {
		SortKey::Path => files.sort_unstable(),
		SortKey::Modified => sort_by_time(files, std::fs::Metadata::modified),
		SortKey::Accessed => sort_by_time(files, std::fs::Metadata::accessed),
		SortKey::Created => sort_by_time(files, std::fs::Metadata::created),
	}
	if spec.reverse {
		files.reverse();
	}
}

pub fn sort_by_time(
	files: &mut Vec<PathBuf>,
	read: fn(&std::fs::Metadata) -> io::Result<std::time::SystemTime>,
) {
	let mut keyed = files
		.drain(..)
		.map(|path| {
			let time = std::fs::metadata(&path)
				.ok()
				.and_then(|meta| read(&meta).ok());
			(time, path)
		})
		.collect::<Vec<_>>();
	keyed.sort_unstable_by(|left, right| match (left.0, right.0) {
		(Some(left_time), Some(right_time)) => left_time
			.cmp(&right_time)
			.then_with(|| left.1.cmp(&right.1)),
		(Some(_), None) => std::cmp::Ordering::Less,
		(None, Some(_)) => std::cmp::Ordering::Greater,
		(None, None) => left.1.cmp(&right.1),
	});
	files.extend(keyed.into_iter().map(|(_, path)| path));
}

#[must_use]
pub fn display_bytes(path: &Path, separator: Option<u8>) -> Vec<u8> {
	let mut bytes = path.as_os_str().as_encoded_bytes().to_vec();
	if let Some(separator) = separator {
		for byte in &mut bytes {
			if *byte == b'/' {
				*byte = separator;
			}
		}
	}
	bytes
}

pub fn resolve_path_separator(flag_value: Option<&str>) -> Result<Option<u8>, String> {
	let Some(value) = flag_value else {
		return Ok(None);
	};
	let unescaped = unescape_separator(value);
	if unescaped.len() == 1 {
		return Ok(Some(unescaped[0]));
	}
	Err(format!(
		"invalid value for --path-separator: expected exactly one byte, but found {}",
		unescaped.len()
	))
}

#[must_use]
pub fn display_path(prefix: Option<&OsStr>, root: &Path, path: &Path) -> PathBuf {
	let rel = path.strip_prefix(root).unwrap_or(path);
	if rel.as_os_str().is_empty() {
		return prefix.map_or_else(|| PathBuf::from("."), PathBuf::from);
	}
	prefix.map_or_else(|| rel.to_path_buf(), |operand| Path::new(operand).join(rel))
}

#[must_use]
pub fn typed_spelling(argv: &[OsString], declared_long: &str, command: &clap::Command) -> String {
	let name = declared_long.trim_start_matches('-');
	let Some(arg) = command
		.get_arguments()
		.find(|arg| arg.get_long() == Some(name))
	else {
		return declared_long.to_string();
	};
	let longs: Vec<&str> = std::iter::once(name)
		.chain(arg.get_all_aliases().unwrap_or_default())
		.collect();
	let short = arg.get_short();
	let mut spelling = None;
	for token in argv.iter().skip(1) {
		let Some(text) = token.to_str() else { continue };
		if text == "--" {
			break;
		}
		if let Some(rest) = text.strip_prefix("--") {
			let written = rest.split('=').next().unwrap_or(rest);
			if longs.contains(&written) {
				spelling = Some(format!("--{written}"));
			}
			continue;
		}
		if let (Some(short), Some(cluster)) = (short, text.strip_prefix('-'))
			&& cluster.contains(short)
		{
			spelling = Some(format!("-{short}"));
		}
	}
	spelling.unwrap_or_else(|| format!("--{name}"))
}

#[must_use]
pub fn argv_diagnostic(
	argv: &[OsString],
	error: &clap::Error,
	command: &clap::Command,
) -> Option<String> {
	use clap::error::{ContextKind, ContextValue, ErrorKind};
	let text = |kind: ContextKind| match error.get(kind) {
		Some(ContextValue::String(value)) => Some(value.clone()),
		_ => None,
	};
	let declared = text(ContextKind::InvalidArg)?;
	let long = declared.split(' ').next().unwrap_or(&declared);
	if !long.starts_with('-') {
		return None;
	}
	match error.kind() {
		ErrorKind::UnknownArgument => Some(format!("unrecognized flag {long}")),
		ErrorKind::ValueValidation => {
			let reason = std::error::Error::source(error)?.to_string();
			Some(format!("error parsing flag {}: {reason}", typed_spelling(argv, long, command)))
		},
		ErrorKind::InvalidValue => {
			let value = text(ContextKind::InvalidValue)?;
			let no_choices = matches!(
				error.get(ContextKind::ValidValue),
				Some(ContextValue::Strings(choices)) if choices.is_empty()
			);
			if value.is_empty() && no_choices {
				return Some(format!(
					"missing value for flag {long}: missing argument for option '{long}'"
				));
			}
			Some(format!(
				"error parsing flag {}: {}",
				typed_spelling(argv, long, command),
				unrecognized_choice(&value)
			))
		},
		_ => None,
	}
}

#[must_use]
pub fn json_duration(elapsed: Duration) -> serde_json::Value {
	serde_json::json!({
		"human": format!("{:.6}s", elapsed.as_secs_f64()),
		"nanos": elapsed.subsec_nanos(),
		"secs": elapsed.as_secs(),
	})
}

pub fn write_json_summary<W: Write>(out: &mut W, stats: &Stats, total: Duration) -> io::Result<()> {
	let summary = serde_json::json!({
		"data": {
			"elapsed_total": json_duration(total),
			"stats": {
				"bytes_printed": stats.bytes_printed(),
				"bytes_searched": stats.bytes_searched(),
				"elapsed": json_duration(stats.elapsed()),
				"matched_lines": stats.matched_lines(),
				"matches": stats.matches(),
				"searches": stats.searches(),
				"searches_with_match": stats.searches_with_match(),
			}
		},
		"type": "summary"
	});
	serde_json::to_writer(&mut *out, &summary).map_err(io::Error::other)?;
	out.write_all(b"\n")
}

pub fn write_stats_summary<W: Write>(
	out: &mut W,
	stats: &Stats,
	total: Duration,
) -> io::Result<()> {
	let searching = stats.elapsed();
	write!(
		out,
		"\n{} matches\n{} matched lines\n{} files contained matches\n{} files searched\n{} bytes \
		 printed\n{} bytes searched\n{:.6} seconds spent searching\n{:.6} seconds total\n",
		stats.matches(),
		stats.matched_lines(),
		stats.searches_with_match(),
		stats.searches(),
		stats.bytes_printed(),
		stats.bytes_searched(),
		searching.as_secs_f64(),
		total.as_secs_f64(),
	)
}
