import { execFile } from "child_process";

export interface ClaudeCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  organizationUuid: string;
  subscriptionType: string;
}

export async function getClaudeCredentials(): Promise<ClaudeCredentials | null> {
  try {
    const raw = await runSecurity([
      "find-generic-password",
      "-s",
      "Claude Code-credentials",
      "-w",
    ]);
    const parsed = JSON.parse(raw.trim());
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken) return null;

    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      organizationUuid: parsed.organizationUuid,
      subscriptionType: oauth.subscriptionType,
    };
  } catch {
    return null;
  }
}

function runSecurity(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", args, { timeout: 5000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}
