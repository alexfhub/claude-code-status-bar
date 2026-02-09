import * as vscode from "vscode";
import { fetchUsageData, UsageData } from "./api";

let statusBarItem: vscode.StatusBarItem;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50
  );
  statusBarItem.command = "claudeCodeStatusBar.refresh";
  statusBarItem.text = "$(cloud) Claude Code: loading...";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const refreshCommand = vscode.commands.registerCommand(
    "claudeCodeStatusBar.refresh",
    () => updateStatusBar()
  );
  context.subscriptions.push(refreshCommand);

  updateStatusBar();
  startRefreshTimer();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeCodeStatusBar")) {
        startRefreshTimer();
      }
    })
  );
}

function startRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  const config = vscode.workspace.getConfiguration("claudeCodeStatusBar");
  const intervalSec = config.get<number>("refreshIntervalSeconds", 60);
  refreshTimer = setInterval(() => updateStatusBar(), intervalSec * 1000);
}

function getCurrencySymbol(): string {
  const config = vscode.workspace.getConfiguration("claudeCodeStatusBar");
  const configured = config.get<string>("currencySymbol", "");
  if (configured) return configured;
  // Auto-detect from locale
  try {
    const locale = vscode.env.language || "en-US";
    const parts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
    }).formatToParts(0);
    const sym = parts.find((p) => p.type === "currency");
    return sym?.value ?? "$";
  } catch {
    return "$";
  }
}

async function updateStatusBar() {
  try {
    const data = await fetchUsageData();
    if (!data) {
      statusBarItem.text = "$(cloud) Claude: no auth";
      statusBarItem.tooltip =
        "Could not read Claude Code credentials from Keychain";
      return;
    }
    renderStatusBar(data);
  } catch (err: any) {
    statusBarItem.text = "$(cloud) Claude: error";
    statusBarItem.tooltip = `Error: ${err.message}`;
  }
}

function renderStatusBar(data: UsageData) {
  const session = data.fiveHour?.utilization;
  const allModels = data.sevenDay?.utilization;
  const sonnet = data.sevenDaySonnet?.utilization;

  const parts: string[] = [];
  if (session != null) parts.push(`S:${Math.round(session)}%`);
  if (allModels != null) parts.push(`W:${Math.round(allModels)}%`);
  if (sonnet != null) parts.push(`Son:${Math.round(sonnet)}%`);

  statusBarItem.text = `$(cloud) Claude ${parts.join(" | ")}`;

  const currency = getCurrencySymbol();
  const planLabel = data.planName ? ` (${data.planName})` : "";
  const tooltipLines: string[] = [`Claude Code Plan Usage${planLabel}`];

  if (session != null) {
    tooltipLines.push(
      `Session (5h): ${Math.round(session)}%${data.fiveHour?.resetsAt ? ` — resets ${formatReset(data.fiveHour.resetsAt)}` : ""}`
    );
  }
  if (allModels != null) {
    tooltipLines.push(
      `Weekly All models: ${Math.round(allModels)}%${data.sevenDay?.resetsAt ? ` — resets ${formatReset(data.sevenDay.resetsAt)}` : ""}`
    );
  }
  if (sonnet != null) {
    tooltipLines.push(
      `Weekly Sonnet: ${Math.round(sonnet)}%${data.sevenDaySonnet?.resetsAt ? ` — resets ${formatReset(data.sevenDaySonnet.resetsAt)}` : ""}`
    );
  }
  if (data.extraUsage?.isEnabled) {
    const used = data.extraUsage.usedCredits ?? 0;
    const limit = data.extraUsage.monthlyLimit ?? 0;
    tooltipLines.push(
      `Extra usage: ${currency}${used.toFixed(2)} / ${currency}${limit.toFixed(2)}`
    );
  }
  tooltipLines.push("", "Click to refresh");

  statusBarItem.tooltip = tooltipLines.join("\n");

  // Color warning thresholds
  if ((session ?? 0) >= 80 || (allModels ?? 0) >= 80) {
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  } else {
    statusBarItem.backgroundColor = undefined;
  }
}

function formatReset(iso: string): string {
  const d = new Date(iso);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  const mStr = m > 0 ? `:${m.toString().padStart(2, "0")}` : "";
  return `${days[d.getDay()]} ${h12}${mStr} ${ampm}`;
}

export function deactivate() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
}
