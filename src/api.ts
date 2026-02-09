import * as https from "https";
import { getClaudeCredentials } from "./keychain";

const BASE_URL = "https://api.anthropic.com";
const USAGE_PATH = "/api/oauth/usage";
const PROFILE_PATH = "/api/oauth/profile";
const ANTHROPIC_BETA = "oauth-2025-04-20";

interface RawLimit {
  utilization: number | null;
  resets_at: string | null;
}

interface RawUsageResponse {
  five_hour: RawLimit | null;
  seven_day: RawLimit | null;
  seven_day_sonnet: RawLimit | null;
  extra_usage: {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
  } | null;
}

interface RawProfileResponse {
  account: {
    full_name: string;
    email: string;
    has_claude_max: boolean;
    has_claude_pro: boolean;
  };
  organization: {
    organization_type: string;
    rate_limit_tier: string;
    subscription_status: string;
  };
}

export interface UsageLimit {
  utilization: number;
  resetsAt?: string;
}

export interface UsageData {
  fiveHour?: UsageLimit;
  sevenDay?: UsageLimit;
  sevenDaySonnet?: UsageLimit;
  extraUsage?: {
    isEnabled: boolean;
    monthlyLimit?: number;
    usedCredits?: number;
    utilization?: number;
  };
  planName?: string;
}

function parseLimit(raw: RawLimit | null): UsageLimit | undefined {
  if (!raw || raw.utilization === null) return undefined;
  return {
    utilization: raw.utilization,
    resetsAt: raw.resets_at ?? undefined,
  };
}

function transformResponse(raw: RawUsageResponse): UsageData {
  const data: UsageData = {};
  const fh = parseLimit(raw.five_hour);
  if (fh) data.fiveHour = fh;
  const sd = parseLimit(raw.seven_day);
  if (sd) data.sevenDay = sd;
  const sds = parseLimit(raw.seven_day_sonnet);
  if (sds) data.sevenDaySonnet = sds;
  if (raw.extra_usage) {
    data.extraUsage = {
      isEnabled: raw.extra_usage.is_enabled,
      monthlyLimit:
        raw.extra_usage.monthly_limit != null
          ? raw.extra_usage.monthly_limit / 100
          : undefined,
      usedCredits:
        raw.extra_usage.used_credits != null
          ? raw.extra_usage.used_credits / 100
          : undefined,
      utilization: raw.extra_usage.utilization ?? undefined,
    };
  }
  return data;
}

function formatPlanName(profile: RawProfileResponse): string {
  const orgType = profile.organization.organization_type;
  const tier = profile.organization.rate_limit_tier;
  // e.g. "claude_max" -> "Max", "claude_pro" -> "Pro"
  let plan = orgType.replace("claude_", "");
  plan = plan.charAt(0).toUpperCase() + plan.slice(1);
  // Append tier multiplier if present (e.g. "default_claude_max_20x" -> "20x")
  const tierMatch = tier.match(/(\d+x)$/);
  if (tierMatch) {
    plan += ` ${tierMatch[1]}`;
  }
  return plan;
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": ANTHROPIC_BETA,
    "Content-Type": "application/json",
  };
}

export async function fetchUsageData(): Promise<UsageData | null> {
  const creds = await getClaudeCredentials();
  if (!creds) return null;

  const headers = authHeaders(creds.accessToken);

  const [usageBody, profileBody] = await Promise.all([
    httpGet(`${BASE_URL}${USAGE_PATH}`, headers),
    httpGet(`${BASE_URL}${PROFILE_PATH}`, headers).catch(() => null),
  ]);

  const raw: RawUsageResponse = JSON.parse(usageBody);
  const data = transformResponse(raw);

  if (profileBody) {
    try {
      const profile: RawProfileResponse = JSON.parse(profileBody);
      data.planName = formatPlanName(profile);
    } catch { /* ignore */ }
  }

  return data;
}

function httpGet(
  url: string,
  headers: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`API returned ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}
