/**
 * evals dashboard.
 *
 * Views (hash-routed):
 *   #/            experiments index — runs grouped by job-name prefix
 *   #/exp/<id>    experiment detail — arm table, dithered comparison charts
 *                 (projected values for in-flight arms, dimmed), task matrix
 *   #/runs        flat run list (legacy view)
 *   #/runs/<name> run detail — normalized trace grid + live trace viewer
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExperimentPage } from "./components/experiment-page";
import { ExperimentsIndex } from "./components/experiments-index";
import { LaunchForm } from "./components/launch-form";
import { RunsPage } from "./components/runs-page";
import { useHashRoute } from "./hooks/use-hash-route";

export function App() {
	const hash = useHashRoute();
	const [showLaunch, setShowLaunch] = useState(false);
	useEffect(() => {
		if (hash !== undefined) {
			window.scrollTo(0, 0);
		}
	}, [hash]);
	const expMatch = hash.match(/^#\/exp\/(.+)$/);
	const runMatch = hash.match(/^#\/runs(?:\/(.+))?$/);
	const view = expMatch ? (
		<ExperimentPage id={decodeURIComponent(expMatch[1])} />
	) : runMatch ? (
		<RunsPage selected={runMatch[1] ? decodeURIComponent(runMatch[1]) : null} />
	) : (
		<ExperimentsIndex />
	);
	const tab = (href: string, label: string, active: boolean) => (
		<a
			href={href}
			className={`rounded px-2 py-0.5 ${active ? "bg-zinc-800 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"}`}
		>
			{label}
		</a>
	);
	return (
		<>
			<header className="sticky top-0 z-10 flex items-center gap-4 border-b border-zinc-800 bg-zinc-950/90 px-4 py-2 backdrop-blur">
				<h1 className="text-sm font-semibold tracking-wide">evals</h1>
				<nav className="flex gap-1 text-sm">
					{tab("#/", "experiments", !expMatch && !runMatch)}
					{tab("#/runs", "runs", !!runMatch)}
				</nav>
				<div className="ml-auto">
					<button
						type="button"
						onClick={() => setShowLaunch(s => !s)}
						className="rounded border border-zinc-700 px-3 py-1 text-sm hover:border-sky-400"
					>
						new run
					</button>
				</div>
			</header>
			{showLaunch && <LaunchForm onDone={() => setShowLaunch(false)} />}
			{view}
		</>
	);
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
