export const INSTALL_COMMANDS = Object.freeze({
  macos: Object.freeze({ prompt: "$", command: "curl -fsSL https://get.veyyon.dev | sh" }),
  linux: Object.freeze({ prompt: "$", command: "curl -fsSL https://get.veyyon.dev | sh" }),
  windows: Object.freeze({ prompt: "PS>", command: "irm https://veyyon.dev/install.ps1 | iex" }),
});

export function installCommandFor(platform) {
  return INSTALL_COMMANDS[platform] ?? INSTALL_COMMANDS.macos;
}

export async function copyInstallCommand(command, clipboard) {
  if (typeof clipboard?.writeText !== "function") return "unavailable";
  try {
    await clipboard.writeText(command);
    return "copied";
  } catch {
    return "failed";
  }
}

function preferredPlatform() {
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  if (/win/i.test(platform)) return "windows";
  if (/linux/i.test(platform)) return "linux";
  return "macos";
}

function bindInstallSelector(root) {
  const prompt = root.querySelector("[data-install-prompt]");
  const command = root.querySelector("[data-install-command]");
  const copy = root.querySelector("[data-install-copy]");
  const buttons = [...root.querySelectorAll("[data-install-platform]")];
  if (!prompt || !command || !copy || buttons.length === 0) return;

  const select = platform => {
    const value = installCommandFor(platform);
    prompt.textContent = value.prompt;
    command.textContent = value.command;
    for (const button of buttons) {
      button.setAttribute("aria-pressed", String(button.dataset.installPlatform === platform));
    }
  };

  for (const button of buttons) {
    button.addEventListener("click", () => select(button.dataset.installPlatform));
  }
  copy.addEventListener("click", async () => {
    copy.textContent = await copyInstallCommand(command.textContent, navigator.clipboard);
    setTimeout(() => {
      copy.textContent = "copy";
    }, 1300);
  });

  select(preferredPlatform());
}

if (typeof document !== "undefined") {
  for (const root of document.querySelectorAll("[data-install-selector]")) bindInstallSelector(root);
}
