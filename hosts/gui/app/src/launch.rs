//! Command-line preflight performed before the platform opens a window.

#[cfg(debug_assertions)]
use std::path::PathBuf;
use std::time::Duration;

#[cfg(debug_assertions)]
use veyyon_gui_core::host::HostEvent;

pub struct Launch {
	pub exit_after: Option<Duration>,
	#[cfg(debug_assertions)]
	pub events:     Vec<HostEvent>,
}

impl Launch {
	pub fn parse(arguments: impl IntoIterator<Item = String>) -> Result<Self, String> {
		let mut arguments = arguments.into_iter();
		let mut exit_after = None;
		#[cfg(debug_assertions)]
		let mut scene = None::<PathBuf>;

		while let Some(argument) = arguments.next() {
			match argument.as_str() {
				"--exit-after" => {
					let value = arguments
						.next()
						.ok_or_else(|| "--exit-after requires milliseconds".to_owned())?;
					let milliseconds = value
						.parse::<u64>()
						.map_err(|_| format!("invalid --exit-after value: {value}"))?;
					exit_after = Some(Duration::from_millis(milliseconds));
				},
				"--scene" => {
					let value = arguments
						.next()
						.ok_or_else(|| "--scene requires a JSONL path".to_owned())?;
					#[cfg(debug_assertions)]
					{
						if scene.replace(PathBuf::from(value)).is_some() {
							return Err("--scene may be specified only once".to_owned());
						}
					}
					#[cfg(not(debug_assertions))]
					{
						let _ = value;
						return Err("--scene is available only in debug builds".to_owned());
					}
				},
				_ => return Err(format!("unknown argument: {argument}")),
			}
		}

		#[cfg(debug_assertions)]
		let events = match scene {
			Some(path) => crate::bridge::scene::load(&path).map_err(|error| error.to_string())?,
			None => Vec::new(),
		};
		Ok(Self {
			exit_after,
			#[cfg(debug_assertions)]
			events,
		})
	}
}
