import * as vscode from "vscode";
import { fetchUsageData, RateLimitError, UsageData } from "./api";

let statusBarItem: vscode.StatusBarItem;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let lastData: UsageData | undefined;
let lastFetchedAt: number | undefined;
let rateLimitedUntil = 0;
let consecutiveFailures = 0;
// Manual refresh click should force a retry even if we're in backoff.
let forceNextRefresh = false;

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
    () => {
      forceNextRefresh = true;
      scheduleNext(0);
    }
  );
  context.subscriptions.push(refreshCommand);

  scheduleNext(0);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeCodeStatusBar")) {
        scheduleNext(getIntervalMs());
      }
    })
  );
}

function getIntervalMs(): number {
  const config = vscode.workspace.getConfiguration("claudeCodeStatusBar");
  const intervalSec = config.get<number>("refreshIntervalSeconds", 60);
  return intervalSec * 1000;
}

function scheduleNext(delayMs: number) {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    void updateStatusBar();
  }, Math.max(0, delayMs));
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
  const now = Date.now();
  const forced = forceNextRefresh;
  forceNextRefresh = false;

  // Respect rate-limit backoff unless the user manually clicked refresh.
  if (!forced && now < rateLimitedUntil) {
    renderBackoff(rateLimitedUntil - now);
    scheduleNext(rateLimitedUntil - now);
    return;
  }

  try {
    const data = await fetchUsageData();
    if (!data) {
      statusBarItem.text = "$(cloud) Claude: no auth";
      statusBarItem.tooltip =
        "Could not read Claude Code credentials from Keychain";
      statusBarItem.backgroundColor = undefined;
      scheduleNext(getIntervalMs());
      return;
    }
    lastData = data;
    lastFetchedAt = Date.now();
    rateLimitedUntil = 0;
    consecutiveFailures = 0;
    renderStatusBar(data);
    scheduleNext(getIntervalMs());
  } catch (err: any) {
    consecutiveFailures += 1;
    if (err instanceof RateLimitError) {
      // Honour Retry-After and add jitter.
      const jitter = Math.floor(Math.random() * 5000);
      rateLimitedUntil = Date.now() + err.retryAfterMs + jitter;
      renderBackoff(err.retryAfterMs + jitter);
      scheduleNext(err.retryAfterMs + jitter);
      return;
    }
    // Non-429 errors: exponential backoff capped at 5 minutes, preserving
    // the last successful data in the status bar so it doesn't flash "error".
    const backoff = Math.min(
      getIntervalMs() * Math.pow(2, consecutiveFailures - 1),
      5 * 60 * 1000
    );
    renderError(err?.message ?? String(err));
    scheduleNext(backoff);
  }
}

function renderBackoff(remainingMs: number) {
  const secs = Math.ceil(remainingMs / 1000);
  if (lastData) {
    renderStatusBar(lastData);
    const existing = statusBarItem.tooltip?.toString() ?? "";
    statusBarItem.tooltip =
      `${existing}\n\n⚠ Rate limited — retrying in ${secs}s` +
      (lastFetchedAt
        ? ` (data from ${formatAge(Date.now() - lastFetchedAt)} ago)`
        : "");
  } else {
    statusBarItem.text = "$(cloud) Claude: rate limited";
    statusBarItem.tooltip = `API rate limited (429). Retrying in ${secs}s.\nClick to retry now.`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  }
}

function renderError(message: string) {
  if (lastData) {
    renderStatusBar(lastData);
    const existing = statusBarItem.tooltip?.toString() ?? "";
    statusBarItem.tooltip =
      `${existing}\n\n⚠ Refresh failed: ${message}` +
      (lastFetchedAt
        ? ` (data from ${formatAge(Date.now() - lastFetchedAt)} ago)`
        : "");
  } else {
    statusBarItem.text = "$(cloud) Claude: error";
    statusBarItem.tooltip = `Error: ${message}\nClick to retry.`;
  }
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
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
    clearTimeout(refreshTimer);
  }
}
