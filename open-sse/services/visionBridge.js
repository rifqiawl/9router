// Modality Bridge — same-provider reroute for vision-incapable targets.
//
// Today, when a request carries image content but the selected model can't
// read images, translator/concerns/modality.js strips the image and leaves a
// placeholder text ("[image omitted: model has no vision support]") — the
// visual information is simply discarded. When enabled (env
// MODALITY_BRIDGE_ENABLED=true), this instead retargets the request to the
// best vision-capable sibling model on the SAME provider before that strip
// step runs, so the model actually sees the image. Falls through to the
// existing strip-and-placeholder behavior when no sibling qualifies — never
// breaks the request.
//
// Deliberately scoped to same-provider swaps: it reuses the credentials the
// caller already resolved for this request, so it needs no new account/auth
// selection and cannot fail the request in a new way. Cross-provider
// rerouting (à la OmniRoute's visionBridgeRouter) would require hooking into
// src/sse/handlers/chat.js's account/model selection loop instead.

import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { PROVIDER_MODELS } from "../config/providerModels.js";
import { FORMATS } from "../translator/formats.js";

function hasImageBlock(blocks) {
  if (!Array.isArray(blocks)) return false;
  return blocks.some((b) => b?.type === "image_url" || b?.type === "image" || b?.type === "input_image");
}

/**
 * Best-effort detection of whether `body` (in `sourceFormat`) carries at
 * least one image/vision content block. Mirrors the block-shape checks in
 * translator/concerns/modality.js without mutating anything.
 */
export function bodyHasVisionContent(body, sourceFormat) {
  if (!body) return false;
  switch (sourceFormat) {
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      return Array.isArray(body.contents) && body.contents.some(
        (c) => Array.isArray(c?.parts) && c.parts.some(
          (p) => p?.inlineData?.mimeType?.startsWith?.("image/") || p?.fileData?.mimeType?.startsWith?.("image/")
        )
      );
    case FORMATS.ANTIGRAVITY:
      return Array.isArray(body?.request?.contents) && body.request.contents.some(
        (c) => Array.isArray(c?.parts) && c.parts.some(
          (p) => p?.inlineData?.mimeType?.startsWith?.("image/") || p?.fileData?.mimeType?.startsWith?.("image/")
        )
      );
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      return Array.isArray(body.input) && body.input.some(
        (item) => Array.isArray(item?.content) && item.content.some((b) => b?.type === "input_image")
      );
    case FORMATS.CLAUDE:
      return Array.isArray(body.messages) && body.messages.some(
        (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === "image")
      );
    default:
      return Array.isArray(body.messages) && body.messages.some((m) => hasImageBlock(m?.content));
  }
}

/**
 * Find the best vision-capable sibling model on the same provider.
 * Prefers a model whose id shares the incapable model's family prefix
 * (e.g. "glm-4.6" -> "glm-4.6v") so cost/latency stay close to what the
 * caller picked, else falls back to the first vision-capable model in the
 * provider's registry. Returns null when no sibling qualifies.
 *
 * @param {string} provider - raw provider id, passed through to getCapabilitiesForModel
 *   (matches the convention at chatCore.js's own `getCapabilitiesForModel(provider, model)` call).
 * @param {string} alias - PROVIDER_MODELS registry key (may differ from `provider` for
 *   OAuth-aliased providers — see PROVIDER_ID_TO_ALIAS).
 */
export function findVisionSiblingModel(provider, alias, model) {
  const list = PROVIDER_MODELS[alias] || [];
  const candidates = list
    .map((m) => (typeof m === "string" ? { id: m } : m))
    .filter((m) => m?.id && m.id !== model)
    .filter((m) => getCapabilitiesForModel(provider, m.id).vision === true);
  if (candidates.length === 0) return null;

  const base = model.split(/[-.]/)[0];
  const sameFamily = candidates.find((m) => m.id.startsWith(base));
  return (sameFamily || candidates[0]).id;
}

/**
 * Resolve the model id to actually dispatch the request to.
 *
 * Returns `model` unchanged unless ALL of:
 *  - MODALITY_BRIDGE_ENABLED=true
 *  - the picked model genuinely can't read images (caps.vision === false)
 *  - the request genuinely carries image content
 *  - a vision-capable sibling exists on the same provider
 *
 * @returns {{ model: string, bridged: boolean }}
 */
export function resolveModalityBridgeModel(provider, alias, model, body, sourceFormat, log) {
  if (process.env.MODALITY_BRIDGE_ENABLED !== "true") return { model, bridged: false };

  const caps = getCapabilitiesForModel(provider, model);
  if (caps.vision !== false) return { model, bridged: false };
  if (!bodyHasVisionContent(body, sourceFormat)) return { model, bridged: false };

  const bridged = findVisionSiblingModel(provider, alias, model);
  if (!bridged) return { model, bridged: false };

  log?.debug?.("MODALITY", `bridge: ${provider}/${model} has no vision -> rerouting to ${provider}/${bridged} (image content detected)`);
  return { model: bridged, bridged: true };
}
