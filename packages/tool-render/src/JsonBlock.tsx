import { Check, Copy } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

export interface JsonBlockProps {
	data: unknown;
	title?: string;
	initialCollapsed?: boolean;
}

async function writeClipboardText(text: string): Promise<boolean> {
	if (
		typeof globalThis === "object" &&
		globalThis !== null &&
		"navigator" in globalThis &&
		typeof globalThis.navigator === "object" &&
		globalThis.navigator !== null &&
		"clipboard" in globalThis.navigator &&
		typeof globalThis.navigator.clipboard === "object" &&
		globalThis.navigator.clipboard !== null &&
		"writeText" in globalThis.navigator.clipboard &&
		typeof globalThis.navigator.clipboard.writeText === "function"
	) {
		await globalThis.navigator.clipboard.writeText(text);
		return true;
	}
	return false;
}

export function JsonBlock({ data, title, initialCollapsed = false }: JsonBlockProps) {
	const [collapsed, setCollapsed] = useState(initialCollapsed);
	const [copied, setCopied] = useState(false);
	const copyResetRef = useRef<NodeJS.Timeout | number | undefined>(undefined);
	const jsonStr = JSON.stringify(data, null, 2);

	useEffect(() => () => clearTimeout(copyResetRef.current), []);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			setCollapsed(!collapsed);
		}
	};

	const handleCopy = async (e: React.MouseEvent) => {
		e.stopPropagation();
		try {
			const success = await writeClipboardText(jsonStr);
			if (!success) return;
			setCopied(true);
			clearTimeout(copyResetRef.current);
			copyResetRef.current = setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard API unavailable; silently no-op.
		}
	};

	return (
		<div className="stats-json-block">
			<div
				className="stats-json-block-header"
				onClick={() => setCollapsed(!collapsed)}
				onKeyDown={handleKeyDown}
				tabIndex={0}
				role="button"
				aria-expanded={!collapsed}
			>
				<span className="stats-json-block-title">{title || "JSON"}</span>
				<div className="stats-json-actions">
					<button
						type="button"
						className="stats-json-copy-btn"
						onClick={handleCopy}
						aria-label={copied ? "Copied to clipboard" : "Copy JSON to clipboard"}
					>
						{copied ? <Check size={13} /> : <Copy size={13} />}
						{copied ? "Copied" : "Copy"}
					</button>
					<span className="stats-json-block-toggle-indicator" data-collapsed={collapsed}>
						{collapsed ? "▶ Show" : "▼ Hide"}
					</span>
				</div>
			</div>
			{!collapsed && (
				<div className="stats-json-block-content-wrapper">
					<pre className="stats-json-block-content">
						<code>{jsonStr}</code>
					</pre>
				</div>
			)}
		</div>
	);
}
