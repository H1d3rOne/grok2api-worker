import type { Env } from "./types";
import type { ModelSpec } from "./models";
import { poolCandidates } from "./models";
import { ApiError } from "./errors";
import { tokensForPools } from "./token-pool";

const rrCounters = new Map<string, number>();

export interface SelectedAccount {
  token: string;
  tokenId: string;
  poolKey: string;
  source: string;
  modeId: string;
}

export async function selectAccount(env: Env, spec: ModelSpec, exclude: Set<string> = new Set()): Promise<SelectedAccount> {
  const pools = poolCandidates(spec);
  const accounts = await tokensForPools(env, pools, exclude);
  if (!accounts.length) {
    throw new ApiError("No GROK SSO tokens configured for this model tier", {
      status: 429,
      type: "rate_limit_error",
    });
  }
  const poolKey = pools.join(",");
  const index = rrCounters.get(poolKey) || 0;
  rrCounters.set(poolKey, index + 1);
  const account = accounts[index % accounts.length];
  if (!account?.token) {
    throw new ApiError("No usable GROK SSO token selected", { status: 429, type: "rate_limit_error" });
  }
  return { token: account.token, tokenId: account.id, poolKey, source: account.source, modeId: spec.modeId };
}
