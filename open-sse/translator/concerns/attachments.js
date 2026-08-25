// Normalize Vercel AI SDK / Hermes-style `attachments` / `experimental_attachments`
// into standard OpenAI content blocks, BEFORE any strip/bridge/translate step runs.
//
// Several clients (observed: Zed's OpenAI-compatible agent panel) attach files
// this way instead of inline `content: [{ type: "image_url" }]` blocks. Every
// translator (openai-to-claude.js, openai-to-gemini.js/convertOpenAIContentToParts,
// ...) only ever reads `msg.content` — none of them read `attachments` or
// `experimental_attachments`. Only two places in the engine even look at that
// field: translator/concerns/modality.js (to strip it when unsupported) and
// services/combo.js (to score which capability a request needs). Neither of
// those forwards the actual image data anywhere. Net effect: a client sending
// images this way gets no error, no strip placeholder — just a silently
// smaller-than-expected request, and the model reports it never saw an image.
import { FORMATS } from "../formats.js";

const ATTACHMENT_SOURCE_FORMATS = [FORMATS.OPENAI, FORMATS.OLLAMA, FORMATS.KIRO, FORMATS.CURSOR, FORMATS.COMMANDCODE];

function mimeFromAttachment(att) {
  if (typeof att.contentType === "string") return att.contentType;
  if (typeof att.mediaType === "string") return att.mediaType;
  if (typeof att.url === "string") {
    const m = att.url.match(/^data:([^;,]+)/);
    if (m) return m[1];
  }
  return null;
}

function blockForAttachment(att) {
  if (!att || typeof att !== "object") return null;
  const mime = mimeFromAttachment(att);
  const url = typeof att.url === "string" ? att.url : (att.data ? `data:${mime || "application/octet-stream"};base64,${att.data}` : null);
  if (!url) return null;

  if (mime?.startsWith("image/") || (!mime && url.startsWith("data:image/"))) {
    return { type: "image_url", image_url: { url } };
  }
  if (mime?.startsWith("audio/")) {
    // OpenAI's input_audio block wants raw base64 + a format string, not a
    // data: URL — only the inline data: case maps cleanly onto that schema.
    const m = url.match(/^data:audio\/([a-z0-9]+);base64,(.+)$/i);
    return m ? { type: "input_audio", input_audio: { data: m[2], format: m[1] } } : null;
  }
  if (mime === "application/pdf" || mime?.startsWith("application/")) {
    return { type: "file", file: { file_data: url, filename: att.name || att.filename || "attachment" } };
  }
  // No usable mime but a data: URL is present — best-effort as an image,
  // the common case for screenshot-drop clients that omit contentType.
  if (!mime && url.startsWith("data:")) {
    return { type: "image_url", image_url: { url } };
  }
  return null;
}

/**
 * Merge `msg.attachments` / `msg.experimental_attachments` into `msg.content`
 * as standard OpenAI content blocks, in place, for every message that carries
 * either field. No-op otherwise. Returns true if anything was merged.
 */
export function normalizeAttachmentsToContent(body, sourceFormat) {
  if (!body || !Array.isArray(body.messages)) return false;
  if (!ATTACHMENT_SOURCE_FORMATS.includes(sourceFormat)) return false;

  let changed = false;
  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object") continue;
    const attachments = msg.experimental_attachments || msg.attachments;
    if (!Array.isArray(attachments) || attachments.length === 0) continue;

    const blocks = attachments.map(blockForAttachment).filter(Boolean);
    if (blocks.length === 0) continue;

    if (typeof msg.content === "string") {
      msg.content = msg.content ? [{ type: "text", text: msg.content }, ...blocks] : blocks;
    } else if (Array.isArray(msg.content)) {
      msg.content.push(...blocks);
    } else {
      msg.content = blocks;
    }

    delete msg.attachments;
    delete msg.experimental_attachments;
    changed = true;
  }
  return changed;
}
