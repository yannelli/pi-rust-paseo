// Subscription accounts of the `subscription-router` extension (extensions/subscription-router in
// pi-rust-extensions): its accounts, usage cache, account policies, and router profiles. The plugin
// reads the extension's files, writes its config file, and runs `/router` for logins and resets.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SUBSCRIPTION_PROVIDERS = [
  { base: "anthropic", label: "Anthropic", short: "Claude", word: "claude" },
  { base: "openai-codex", label: "OpenAI Codex", short: "Codex", word: "codex" },
] as const;
export type SubscriptionBase = (typeof SUBSCRIPTION_PROVIDERS)[number]["base"];
export const SUBSCRIPTION_BASES = ["anthropic", "openai-codex"] as const;

export const ACCOUNT_STRATEGIES = ["balance", "fill", "threshold", "manual"] as const;
export type AccountStrategy = (typeof ACCOUNT_STRATEGIES)[number];
export const STRATEGY_HELP: Record<AccountStrategy, string> = {
  balance: "The account with the most quota left for the time left. It stays unless another is clearly better.",
  fill: "Stay on one account until it is full, then move to the next.",
  threshold: "Like fill, but an account counts as full at the percent you set.",
  manual: "Always the account you choose.",
};

export const RESET_USES = ["off", "when-full", "when-all-full"] as const;
export type ResetUse = (typeof RESET_USES)[number];
export const RESET_HELP: Record<ResetUse, string> = {
  off: "Never spend a banked usage reset.",
  "when-full": "Spend one as soon as the account in use is full.",
  "when-all-full": "Spend one only when every account is full, before falling back.",
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const EntrySchema = z.object({
  /** `provider/id`; for anthropic and openai-codex models, `account` picks the login. */
  model: z.string().regex(/^[^/\s]+\/\S+$/, "Use provider/model-id."),
  account: z.number().int().min(1).max(99).optional(),
  thinking: z.enum(THINKING_LEVELS).optional(),
});
export type Entry = z.infer<typeof EntrySchema>;

export const PolicySchema = z.object({
  strategy: z.enum(ACCOUNT_STRATEGIES),
  account: z.number().int().min(1).max(99),
  switchAt: z.number().gt(0).max(100),
  fallback: z.array(EntrySchema),
  returnWhenAvailable: z.boolean(),
  useResets: z.enum(RESET_USES),
  resetMinWaitMinutes: z.number().min(0),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = {
  strategy: "balance",
  account: 1,
  switchAt: 90,
  fallback: [],
  returnWhenAvailable: true,
  useResets: "off",
  resetMinWaitMinutes: 60,
};

export const WindowSchema = z.object({
  name: z.string(),
  usedPercent: z.number(),
  resetAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  scope: z.string(),
  families: z.array(z.string()).nullable(),
});
export type UsageWindow = z.infer<typeof WindowSchema>;

export const UsageSchema = z.object({
  status: z.string(),
  windows: z.array(WindowSchema),
  tier: z.string().nullable(),
  retrievedAt: z.number(),
  message: z.string().nullable(),
  unlimited: z.boolean(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AccountSchema = z.object({
  provider: z.string(),
  slot: z.number(),
  name: z.string(),
  /** `pi`: pi stores the login; `router`: the router keeps the token; `missing`: no login found. */
  login: z.enum(["pi", "router", "missing"]),
  usage: UsageSchema.nullable(),
});
export type SubscriptionAccount = z.infer<typeof AccountSchema>;

export const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, "Lowercase letters, digits, dots, hyphens, and underscores."),
  name: z.string(),
  strategy: z.enum(["ordered", "balanced"]),
  chain: z.array(EntrySchema).min(1, "Add at least one model."),
  exhaustionPolicy: z.enum(["wait", "fail"]).nullable(),
  maxWaitMinutes: z.number().positive().nullable(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const routerStateRpc = defineRpc({
  name: "router.state",
  input: z.object({}),
  output: z.object({
    /** pi sends `before_provider_auth`, so accounts are logins of one provider. */
    accountsMode: z.boolean(),
    piVersion: z.string().nullable(),
    configPath: z.string(),
    configError: z.string().nullable(),
    autoSwitchOn429: z.boolean(),
    providers: z.array(
      z.object({ base: z.enum(SUBSCRIPTION_BASES), label: z.string(), short: z.string(), accounts: z.array(AccountSchema), policy: PolicySchema }),
    ),
    profiles: z.array(ProfileSchema),
  }),
});

export const routerPolicySaveRpc = defineRpc({
  name: "router.policy.save",
  input: z.object({ provider: z.enum(SUBSCRIPTION_BASES), policy: PolicySchema }),
  output: z.object({ path: z.string() }),
});

export const routerProfilesSaveRpc = defineRpc({
  name: "router.profiles.save",
  input: z.object({ profiles: z.array(ProfileSchema), autoSwitchOn429: z.boolean().optional() }),
  output: z.object({ path: z.string() }),
});

export const ROUTER_ACTIONS = ["refresh", "login-start", "login-finish", "remove", "resets-list", "resets-use"] as const;

export const routerRunRpc = defineRpc({
  name: "router.run",
  input: z.object({
    action: z.enum(ROUTER_ACTIONS),
    provider: z.string().regex(/^[a-z0-9-]+$/).optional(),
    id: z.string().regex(/^[0-9a-f]+$/).optional(),
    pasted: z.string().max(4000).optional(),
    account: z.number().int().min(1).max(99).optional(),
  }),
  output: z.object({ ok: z.boolean(), output: z.string(), data: z.unknown().nullable() }),
});

/** `anthropic-2` → anthropic, account 2; `anthropic` → account 1. */
export function parseAccountProvider(provider: string): { base: SubscriptionBase; slot: number } | null {
  for (const base of SUBSCRIPTION_BASES) {
    if (provider === base) return { base, slot: 1 };
    const match = new RegExp(`^${base}-([1-9][0-9]*)$`).exec(provider);
    if (match && Number(match[1]) >= 2) return { base, slot: Number(match[1]) };
  }
  return null;
}

export function accountProvider(base: SubscriptionBase, slot: number): string {
  return slot <= 1 ? base : `${base}-${slot}`;
}
