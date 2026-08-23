interface QuotaDecision {
  allowed: boolean;
  reason?: string;
}

export class QuotaManager {
  private activeCalls = 0;
  private globalDay = "";
  private globalCalls = 0;
  private sessionCalls = new Map<string, number[]>();
  private ipCalls = new Map<string, number[]>();

  readonly limits = {
    maxCallSeconds: Number(process.env.MAX_CALL_SECONDS ?? 300),
    maxConcurrentCalls: Number(process.env.MAX_CONCURRENT_CALLS ?? 3),
    maxDailyCalls: Number(process.env.MAX_DAILY_CALLS ?? 50),
    maxSessionCallsPerHour: Number(process.env.MAX_SESSION_CALLS_PER_HOUR ?? 5),
    maxIpCallsPerDay: Number(process.env.MAX_IP_CALLS_PER_DAY ?? 10),
  };

  checkAndConsume(sessionId: string, ip: string): QuotaDecision {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.globalDay) {
      this.globalDay = day;
      this.globalCalls = 0;
      this.ipCalls.clear();
    }
    const recentSession = (this.sessionCalls.get(sessionId) ?? []).filter((time) => time > now - 60 * 60_000);
    const recentIp = (this.ipCalls.get(ip) ?? []).filter((time) => time > now - 24 * 60 * 60_000);
    this.sessionCalls.set(sessionId, recentSession);
    this.ipCalls.set(ip, recentIp);

    if (this.activeCalls >= this.limits.maxConcurrentCalls) {
      return { allowed: false, reason: "The live demo is at its concurrency limit. Scenario Playback is still available." };
    }
    if (this.globalCalls >= this.limits.maxDailyCalls) {
      return { allowed: false, reason: "Today's live-AI quota is exhausted. Scenario Playback is still available." };
    }
    if (recentSession.length >= this.limits.maxSessionCallsPerHour) {
      return { allowed: false, reason: "This browser session reached its hourly live-call limit." };
    }
    if (recentIp.length >= this.limits.maxIpCallsPerDay) {
      return { allowed: false, reason: "This network reached its daily live-call limit." };
    }

    this.activeCalls += 1;
    this.globalCalls += 1;
    recentSession.push(now);
    recentIp.push(now);
    return { allowed: true };
  }

  release(): void {
    this.activeCalls = Math.max(0, this.activeCalls - 1);
  }
}
