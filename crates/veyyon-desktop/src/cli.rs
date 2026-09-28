//! The command line: the binary opens the window and attaches it to a host.

use clap::Parser;

/// The veyyon desktop front end.
#[derive(Debug, Parser)]
#[command(name = "veyyon-desktop", version, about)]
pub struct Cli {
	/// The GUI host endpoint to attach to. Without one the desktop starts a
	/// host of its own.
	#[arg(long)]
	pub endpoint: Option<String>,
}
