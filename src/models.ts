import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

export interface TldrModelPreference {
  provider: string;
  id: string;
}

export interface TldrModelAuth {
  model: Model<Api>;
  apiKey: string;
  headers?: Record<string, string>;
}

export const FAST_MODEL_CANDIDATES: readonly TldrModelPreference[] = [
  { provider: "openai-codex", id: "gpt-5.4-mini" },
  { provider: "openai-codex", id: "gpt-5.3-codex-spark" },
  { provider: "anthropic", id: "claude-haiku-4-5" },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
];

export function parseModelSpec(value: string | undefined): TldrModelPreference | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "auto") return undefined;
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, separator), id: trimmed.slice(separator + 1) };
}

export function formatModelPreference(model?: TldrModelPreference): string {
  return model ? `${model.provider}/${model.id}` : "auto";
}

export function formatAuthModel(auth?: TldrModelAuth): string {
  return auth ? `${auth.model.provider}/${auth.model.id}` : "none";
}

export function resolveInitialModelPreference(cwd: string): TldrModelPreference | undefined {
  const settings = SettingsManager.create(cwd);
  return parseSettings(settings.getProjectSettings() as Record<string, unknown>)
    ?? parseSettings(settings.getGlobalSettings() as Record<string, unknown>);
}

export function parseSettings(settings: Record<string, unknown>): TldrModelPreference | undefined {
  return parseSection(settings.tldrLite) ?? parseSection(settings.tldr);
}

async function authFor(ctx: ExtensionContext, preference: TldrModelPreference): Promise<TldrModelAuth | undefined> {
  const model = ctx.modelRegistry.find(preference.provider, preference.id);
  if (!model) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;
  return { model, apiKey: auth.apiKey, ...(auth.headers ? { headers: auth.headers } : {}) };
}

export async function getTldrModelAuth(ctx: ExtensionContext, configuredModel?: TldrModelPreference): Promise<TldrModelAuth | undefined> {
  if (configuredModel) {
    const configuredAuth = await authFor(ctx, configuredModel);
    if (configuredAuth) return configuredAuth;
  }

  const configuredKey = configuredModel ? formatModelPreference(configuredModel) : undefined;
  for (const candidate of FAST_MODEL_CANDIDATES) {
    if (configuredKey === formatModelPreference(candidate)) continue;
    const auth = await authFor(ctx, candidate);
    if (auth) return auth;
  }
  return undefined;
}

function parseSection(section: unknown): TldrModelPreference | undefined {
  if (!section || typeof section !== "object" || Array.isArray(section)) return undefined;
  const model = (section as Record<string, unknown>).model;
  return typeof model === "string" ? parseModelSpec(model) : undefined;
}
