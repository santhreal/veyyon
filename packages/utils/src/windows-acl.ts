import { spawn } from "node:child_process";
import * as path from "node:path";
import { escapeTerminalText } from "./terminal-safe";
import { errorMessage } from "./type-guards";

const MAX_COMMAND_OUTPUT_BYTES = 16 * 1024;
const WINDOWS_ACL_TIMEOUT_MS = 15_000;

export interface WindowsAclCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Injectable only so ACL behavior can be exercised on non-Windows test hosts. */
export type WindowsAclCommandRunner = (script: string, filePath: string) => Promise<WindowsAclCommandResult>;

export interface WindowsAclOptions {
	platform?: NodeJS.Platform;
	run?: WindowsAclCommandRunner;
	/** Low-level injection for exercising process lifecycle behavior without PowerShell. */
	spawn?: typeof spawn;
}

const VERIFY_ACL = `
if ($item.PSProvider.Name -ne 'FileSystem') { throw 'ACL target is not a filesystem path' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$actual = Get-Acl -LiteralPath $target -ErrorAction Stop
$owner = $actual.GetOwner([Security.Principal.SecurityIdentifier])
if (-not $owner.Equals($identity)) { throw 'ACL owner is not the current user' }
if (-not $actual.AreAccessRulesProtected) { throw 'ACL inheritance is enabled' }
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 1) { throw 'ACL does not contain exactly one access rule' }
$rule = $rules[0]
if ($rule.IsInherited) { throw 'ACL contains an inherited access rule' }
if (-not $rule.IdentityReference.Equals($identity)) { throw 'ACL grants another identity access' }
if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'ACL owner rule is not an allow rule' }
if ($rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'ACL owner rule is not exactly full control' }
if ($rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'ACL owner rule has unexpected propagation flags' }
if ($item.PSIsContainer) {
  $expectedInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  if ($rule.InheritanceFlags -ne $expectedInheritance) { throw 'ACL directory owner rule does not protect descendants' }
} elseif ($rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]::None) {
  throw 'ACL file owner rule has unexpected inheritance flags'
}
`;

const APPLY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('VEYYON_OWNER_ONLY_ACL_PATH', 'Process')
if ([string]::IsNullOrEmpty($target)) { throw 'ACL target is missing' }
$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ($item.PSIsContainer) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  $acl = New-Object Security.AccessControl.FileSecurity
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
}
$acl.SetOwner($identity)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object Security.AccessControl.FileSystemAccessRule(
  $identity,
  [Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [Security.AccessControl.PropagationFlags]::None,
  [Security.AccessControl.AccessControlType]::Allow
)
[void]$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $target -AclObject $acl -ErrorAction Stop
${VERIFY_ACL}
[Console]::Out.Write('OK')
`;

const VERIFY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('VEYYON_OWNER_ONLY_ACL_PATH', 'Process')
$item = Get-Item -LiteralPath $target -Force -ErrorAction Stop
if ([string]::IsNullOrEmpty($target)) { throw 'ACL target is missing' }
${VERIFY_ACL}
[Console]::Out.Write('OK')
`;

/** Apply a protected DACL granting access exclusively to the current Windows user. */
export async function applyOwnerOnlyWindowsAcl(filePath: string, options: WindowsAclOptions = {}): Promise<void> {
	await runOwnerOnlyAcl(APPLY_SCRIPT, filePath, options);
}

/** Verify that a path has a protected owner-only DACL; rejects on any ambiguity. */
export async function verifyOwnerOnlyWindowsAcl(filePath: string, options: WindowsAclOptions = {}): Promise<void> {
	await runOwnerOnlyAcl(VERIFY_SCRIPT, filePath, options);
}

async function runOwnerOnlyAcl(script: string, filePath: string, options: WindowsAclOptions): Promise<void> {
	const platform = options.platform ?? process.platform;
	if (platform !== "win32") return;
	if (filePath.length === 0 || filePath.includes("\0")) throw new Error("The Windows ACL path is invalid.");

	let result: WindowsAclCommandResult;
	try {
		result =
			options.run === undefined
				? await defaultWindowsAclRunner(script, filePath, options.spawn)
				: await options.run(script, filePath);
	} catch (error) {
		const message = errorMessage(error);
		const detail = boundedDiagnostic(message.length === 0 ? "unknown command error" : message);
		throw new Error(`The owner-only Windows ACL operation failed (${detail}).`, { cause: error });
	}
	if (result.exitCode !== 0 || result.stdout !== "OK" || result.stderr !== "") {
		const status = result.exitCode === 0 ? "unexpected success output" : `exit code ${result.exitCode}`;
		const output = result.stderr || result.stdout;
		const detail = boundedDiagnostic(output.length === 0 ? status : `${status}: ${output}`);
		throw new Error(`The owner-only Windows ACL operation failed (${detail}).`);
	}
}

async function defaultWindowsAclRunner(
	script: string,
	filePath: string,
	spawnProcess: typeof spawn = spawn,
): Promise<WindowsAclCommandResult> {
	const configuredSystemRoot = process.env.SystemRoot;
	const driveRoot = configuredSystemRoot === undefined ? "" : path.win32.parse(configuredSystemRoot).root;
	if (configuredSystemRoot === undefined || !/^[A-Za-z]:[\\/]$/.test(driveRoot)) {
		throw new Error("A trusted drive-qualified Windows system root is unavailable.");
	}
	const systemRoot = path.win32.normalize(configuredSystemRoot);
	const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	return await new Promise<WindowsAclCommandResult>((resolve, reject) => {
		const child = spawnProcess(
			powershell,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
			{
				env: { SystemRoot: systemRoot, VEYYON_OWNER_ONLY_ACL_PATH: filePath },
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			},
		);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let totalBytes = 0;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;
		const stopCollecting = (destroy: boolean): void => {
			child.stdout.off("data", onStdout);
			child.stderr.off("data", onStderr);
			if (destroy) {
				child.stdout.destroy();
				child.stderr.destroy();
			}
		};
		const fail = (error: Error, terminate: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (terminate) {
				try {
					child.kill();
				} catch {}
			}
			stopCollecting(true);
			stdout.length = 0;
			stderr.length = 0;
			reject(error);
		};
		const collect = (destination: Buffer[], chunk: Buffer): void => {
			if (settled) return;
			totalBytes += chunk.length;
			if (totalBytes > MAX_COMMAND_OUTPUT_BYTES) {
				fail(new Error("The Windows ACL command produced excessive output."), true);
				return;
			}
			destination.push(chunk);
		};
		const onStdout = (chunk: Buffer): void => collect(stdout, chunk);
		const onStderr = (chunk: Buffer): void => collect(stderr, chunk);
		const decode = (chunks: Buffer[]): string => {
			if (chunks.length === 0) return "";
			const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
			return bytes.toString("utf8").trim();
		};
		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		child.once("error", error => fail(error, false));
		child.once("close", code => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stopCollecting(false);
			resolve({
				exitCode: code ?? -1,
				stdout: decode(stdout),
				stderr: decode(stderr),
			});
		});
		timer = setTimeout(() => {
			fail(new Error("The Windows ACL command timed out."), true);
		}, WINDOWS_ACL_TIMEOUT_MS);
	});
}

function boundedDiagnostic(value: string): string {
	const inert = escapeTerminalText(value);
	return inert.length <= 512 ? inert : `${inert.slice(0, 511)}…`;
}
