//! The operator loop's command line (§9.4, §9.5, §9.3).
//!
//! With no subcommand the binary opens the window. The subcommands are the
//! headless half of the iteration engine: list the scene catalogue, render a
//! scene set to PNGs or one contact sheet, sweep one token across a scene set,
//! and dump the live token set back out as authored files.

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};
use veyyon_desktop_scene::Appearance;

/// The veyyon desktop front end.
#[derive(Debug, Parser)]
#[command(name = "veyyon-desktop", version, about)]
pub struct Cli {
	/// The GUI host endpoint to attach to. Without one the desktop starts a
	/// host of its own.
	#[arg(long, global = true)]
	pub endpoint: Option<String>,

	#[command(subcommand)]
	pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
	/// Scene catalogue: list, or render headless.
	#[command(subcommand)]
	Scene(SceneCommand),
	/// Render one scene set at k values of one token and tile the results.
	Sweep(SweepCommand),
	/// The live token set.
	#[command(subcommand)]
	Tokens(TokensCommand),
}

#[derive(Debug, Subcommand)]
pub enum SceneCommand {
	/// Print every registered scene, one per line, as `surface/state`.
	List {
		/// Scene name or glob (`queue-card/*`, `*/rest`, `*`).
		#[arg(default_value = "*")]
		pattern: String,
	},
	/// Render the scenes a pattern matches.
	Render(RenderCommand),
}

/// Which appearance to render in, as the command line spells it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum AppearanceArg {
	Dark,
	Light,
}

impl From<AppearanceArg> for Appearance {
	fn from(arg: AppearanceArg) -> Self {
		match arg {
			AppearanceArg::Dark => Self::Dark,
			AppearanceArg::Light => Self::Light,
		}
	}
}

/// Everything that decides the bytes a render produces, from the command line.
#[derive(Debug, Args, Clone)]
pub struct FrameArgs {
	/// Logical width in pixels.
	#[arg(long, default_value_t = 1180)]
	pub width:      u32,
	/// Logical height in pixels.
	#[arg(long, default_value_t = 800)]
	pub height:     u32,
	/// Device pixels per logical pixel.
	#[arg(long, default_value_t = 1.0)]
	pub scale:      f32,
	#[arg(long, value_enum, default_value_t = AppearanceArg::Dark)]
	pub appearance: AppearanceArg,
}

#[derive(Debug, Args)]
pub struct RenderCommand {
	/// Scene name or glob.
	pub pattern: String,

	#[command(flatten)]
	pub frame: FrameArgs,

	/// Tile every matched scene into one labelled sheet instead of one PNG
	/// per scene.
	#[arg(long)]
	pub contact_sheet: bool,

	/// Cells per sheet row.
	#[arg(long, default_value_t = 4)]
	pub columns: u32,

	/// Directory the PNGs are written under.
	#[arg(long, default_value = "target/desktop-scenes")]
	pub out: PathBuf,
}

#[derive(Debug, Args)]
pub struct SweepCommand {
	/// The token to sweep, as `<file>:<dotted.key>`, e.g.
	/// `surface/queue.toml:geometry.card_layout.header_gap`.
	pub token: String,

	/// Scene name or glob to render at every candidate.
	#[arg(long)]
	pub scene: String,

	/// First candidate: a scale step (`s1`) or a number (`0.04`).
	#[arg(long, required_unless_present = "values")]
	pub from: Option<String>,

	/// Last candidate, inclusive, of the same kind as `--from`.
	#[arg(long, required_unless_present = "values")]
	pub to: Option<String>,

	/// Candidate count for a numeric range. A step range has one candidate
	/// per step and ignores this.
	#[arg(long, default_value_t = 8)]
	pub steps: u32,

	/// Explicit candidates, comma separated, instead of a range.
	#[arg(long, value_delimiter = ',', conflicts_with_all = ["from", "to"])]
	pub values: Vec<String>,

	#[command(flatten)]
	pub frame: FrameArgs,

	/// Cells per sheet row.
	#[arg(long, default_value_t = 4)]
	pub columns: u32,

	/// The sheet's path.
	#[arg(long, default_value = "target/desktop-scenes/sweep.png")]
	pub out: PathBuf,

	/// Where each candidate's token directory is materialised. Never a
	/// temporary directory: the candidate set is part of the sweep's record.
	#[arg(long, default_value = "target/desktop-sweep")]
	pub work_dir: PathBuf,
}

#[derive(Debug, Subcommand)]
pub enum TokensCommand {
	/// Write the live token set out as authored TOML.
	Dump {
		/// Directory the files are written under.
		#[arg(long, default_value = "target/desktop-tokens")]
		out: PathBuf,
	},
}
