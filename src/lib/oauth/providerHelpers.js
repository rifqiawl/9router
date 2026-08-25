const BASE64_BLOCK_SIZE = 4;

function validateXaiOAuthEndpoint(rawUrl, field) {
  const value = String(rawUrl || "").trim();
  if (!value) throw new Error(`xai discovery ${field} is empty`);
  let parsed;
  try { parsed = new URL(value); } catch (err) {
    throw new Error(`xai discovery ${field} is invalid: ${err.message}`);
  }
  if (parsed.protocol !== "https:") throw new Error(`xai discovery ${field} must use https: ${value}`);
  const host = parsed.hostname.toLowerCase().trim();
  if (host !== "x.ai" && !host.endsWith(".x.ai")) {
    throw new Error(`xai discovery ${field} host ${host} is not on x.ai`);
  }
  return value;
}

function decodeXaiIdTokenEmail(idToken) {
  if (!idToken || typeof idToken !== "string") return undefined;
  const parts = idToken.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const json = Buffer.from(base64 + "=".repeat(padding), "base64").toString("utf8");
    const payload = JSON.parse(json);
    return payload.email || payload.preferred_username || payload.sub || undefined;
  } catch {
    return undefined;
  }
}

function decodeJwtPayload(jwt) {
  try {
    if (!jwt || typeof jwt !== "string") return null;
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding = (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) % BASE64_BLOCK_SIZE;
    const padded = base64 + "=".repeat(missingPadding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractEmailFromAccessToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  return payload.email || payload.preferred_username || payload.sub || undefined;
}

// Regions where AWS currently hosts the Amazon Q Developer profile, regardless
// of which region the IAM Identity Center (IdC) instance itself lives in — AWS
// stores Q Developer profile data ONLY in these regions
// ("Regardless of the IAM Identity Center Region, data is stored in the
// Region where you create the Amazon Q Developer profile"). An IdC in any
// other region (e.g. eu-north-1) still resolves to a profile in one of these.
const KIRO_PROFILE_REGIONS = ["us-east-1", "eu-central-1"];

function kiroListProfilesHost(region) {
  // us-east-1 keeps the legacy codewhisperer host (AWS Builder ID home
  // region); other regions use the regional Amazon Q endpoint.
  return region === "us-east-1"
    ? "https://codewhisperer.us-east-1.amazonaws.com"
    : `https://q.${region}.amazonaws.com`;
}

async function listKiroProfilesForRegion(accessToken, region) {
  try {
    const response = await fetch(`${kiroListProfilesHost(region)}/ListAvailableProfiles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ maxResults: 10 }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.profiles?.find((p) => p.arn?.trim())?.arn?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Discover a Kiro/CodeWhisperer profile ARN for an OAuth access token.
 *
 * Only probing us-east-1 misses any account whose Q Developer profile was
 * provisioned in eu-central-1 — most commonly IAM Identity Center (IdC)
 * accounts, whose IdC instance can live in any AWS region while the profile
 * itself is pinned to us-east-1 or eu-central-1. For those accounts the old
 * single-region call returned zero profiles, so profileArn stayed null and
 * every request either fell back to a shared default profile it doesn't own
 * (403) or was sent without one at all — surfacing as "model unavailable" /
 * intermittent access, not a clean error pointing at the real cause.
 *
 * `preferredRegion` (e.g. a previously-stored region for this connection) is
 * probed first when it's a known profile region, purely to save a round-trip
 * on the common case — every region is still tried on a miss.
 *
 * @param {string} accessToken
 * @param {string} [preferredRegion]
 * @returns {Promise<string|null>}
 */
export async function fetchKiroProfileArn(accessToken, preferredRegion) {
  if (!accessToken) return null;

  const regions = KIRO_PROFILE_REGIONS.includes(preferredRegion)
    ? [preferredRegion, ...KIRO_PROFILE_REGIONS.filter((r) => r !== preferredRegion)]
    : KIRO_PROFILE_REGIONS;

  for (const region of regions) {
    const arn = await listKiroProfilesForRegion(accessToken, region);
    if (arn) return arn;
  }
  return null;
}

export function extractCodexAccountInfo(idToken) {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return {};
  const chatgpt = payload["https://api.openai.com/auth"] || {};
  return {
    email: payload.email,
    chatgptAccountId: chatgpt.chatgpt_account_id || payload.account_id,
    chatgptPlanType: chatgpt.chatgpt_plan_type || payload.plan_type,
  };
}

export {
  BASE64_BLOCK_SIZE,
  validateXaiOAuthEndpoint,
  decodeXaiIdTokenEmail,
  decodeJwtPayload,
  extractEmailFromAccessToken,
};
