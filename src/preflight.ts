// Startup credential check. Resolves the SDK credential chain once, says which source answered, and turns the SDK's
// SSO/expiry errors into the command that fixes them. Fails fast so a demo never starts on a dead session.
import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

export type Preflight = { ok: true; source: string; accountId?: string; expiration?: Date } | { ok: false; source: string; message: string; fix: string };

/** Which credential source the default chain will consult first, from the environment alone. */
export function credentialSource(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AWS_BEARER_TOKEN_BEDROCK) return "AWS_BEARER_TOKEN_BEDROCK (Bedrock API key)";
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return env.AWS_SESSION_TOKEN ? "static keys + session token from the environment" : "static keys from the environment";
  if (env.AWS_PROFILE) return `profile "${env.AWS_PROFILE}" (~/.aws/config)`;
  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) return "container credentials";
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE) return "web identity token";
  return 'default profile (~/.aws/credentials or ~/.aws/config); set AWS_PROFILE in .env to pick another';
}

export function explain(err: unknown, source: string): { message: string; fix: string } {
  const name = (err as { name?: string })?.name ?? "";
  const message = (err as { message?: string })?.message ?? String(err);
  const profile = process.env.AWS_PROFILE ? ` --profile ${process.env.AWS_PROFILE}` : "";
  if (/sso/i.test(message) && /expired|invalid|refresh/i.test(message)) return { message, fix: `aws sso login${profile}` };
  if (/sso/i.test(message) && /token/i.test(message)) return { message, fix: `aws sso login${profile}` };
  if (/Could not load credentials/i.test(message) || name === "CredentialsProviderError") {
    return { message, fix: process.env.AWS_PROFILE
      ? `check that profile "${process.env.AWS_PROFILE}" exists in ~/.aws/config, then aws sso login${profile} (SSO) or aws configure${profile} (keys)`
      : "put AWS_PROFILE=<profile> in .env (SSO or keys), or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or AWS_BEARER_TOKEN_BEDROCK" };
  }
  if (/ExpiredToken|expired/i.test(message)) return { message, fix: `credentials expired: aws sso login${profile} (SSO) or refresh the keys in .env` };
  return { message, fix: "see the AWS SDK credential chain notes in the README" };
}

export async function preflight(client: Pick<BedrockRuntimeClient, "config">): Promise<Preflight> {
  const source = credentialSource();
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return { ok: true, source }; // bearer auth skips the SigV4 chain entirely
  try {
    const creds = await (client.config as { credentials: () => Promise<{ accountId?: string; expiration?: Date }> }).credentials();
    return { ok: true, source, accountId: creds.accountId, expiration: creds.expiration };
  } catch (err) {
    return { ok: false, source, ...explain(err, source) };
  }
}

export function describe(p: Preflight, region: string): string {
  if (!p.ok) return `bedrouter: credentials NOT available (${p.source})\n  ${p.message}\n  fix: ${p.fix}`;
  const bits = [`credentials: ${p.source}`, `region ${region}`];
  if (p.accountId) bits.push(`account ${p.accountId}`);
  if (p.expiration) bits.push(`expires ${p.expiration.toISOString()} (${Math.round((p.expiration.getTime() - Date.now()) / 60000)} min)`);
  return `bedrouter: ${bits.join(", ")}`;
}
