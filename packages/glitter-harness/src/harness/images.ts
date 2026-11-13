/**
 * Image checks that run before a provider call. They read image parts only
 * and never rewrite tool arguments that a person already approved.
 */

/** Types Anthropic and the OpenAI image endpoints both accept. */
export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
/** Same byte cap the composer uses for an attachment. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Enough for a contact sheet, below the stricter provider caps. */
export const MAX_IMAGE_COUNT = 20;
/** Longest side either wire family documents as acceptable. */
export const MAX_IMAGE_EDGE = 8_000;

type ImageBits = { mediaType: string; data: string };
type InspectedMessage = {
  content?: readonly { type: string; mediaType?: string; data?: string }[];
  results?: readonly { images?: readonly ImageBits[] }[];
  toolCalls?: readonly { input: Record<string, unknown> }[];
};

/** Why these images must not be sent, or undefined when the request may proceed. */
export function imageRequestProblem(messages: readonly InspectedMessage[], supported: boolean | null): string | undefined {
  const images = messages.flatMap(messageImages);
  if (!images.length) return undefined;
  if (supported === false) return "This model does not accept images. Remove them and send the text.";
  if (images.length > MAX_IMAGE_COUNT) return `A request can include at most ${MAX_IMAGE_COUNT} images.`;
  for (const [index, image] of images.entries()) {
    const problem = oneImageProblem(image, index + 1);
    if (problem) return problem;
  }
  return undefined;
}

function messageImages(message: InspectedMessage): ImageBits[] {
  const fromContent = (message.content ?? []).flatMap((part) => part.type === "image" ? [{ mediaType: part.mediaType ?? "", data: part.data ?? "" }] : []);
  const fromTools = (message.results ?? []).flatMap((result) => result.images ?? []);
  return [...fromContent, ...fromTools];
}

function oneImageProblem(image: ImageBits, index: number): string | undefined {
  const type = image.mediaType.toLowerCase();
  if (!IMAGE_MEDIA_TYPES.includes(type as (typeof IMAGE_MEDIA_TYPES)[number])) return `Image ${index} must be PNG, JPEG, GIF, or WebP.`;
  const data = image.data;
  // Buffer.from silently ignores invalid base64 characters, which would turn a
  // damaged attachment into different bytes before it reaches the provider.
  if (data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) return `Image ${index} is larger than 10 MB.`;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1 || (data.includes("=") && data.length % 4 !== 0)) return `Image ${index} is not valid base64.`;
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "")) return `Image ${index} is not valid base64.`;
  if (!bytes.length) return `Image ${index} is empty.`;
  if (bytes.length > MAX_IMAGE_BYTES) return `Image ${index} is larger than 10 MB.`;
  const size = dimensions(bytes, type);
  if (!size) return `Image ${index} is not a valid ${type.slice("image/".length).toUpperCase()} file.`;
  if (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE || size.width < 1 || size.height < 1) {
    return `Image ${index} is ${size.width}×${size.height}, which is larger than ${MAX_IMAGE_EDGE} pixels on a side.`;
  }
  return undefined;
}

function dimensions(bytes: Buffer, type: string): { width: number; height: number } | undefined {
  if (type === "image/png") return pngSize(bytes);
  if (type === "image/jpeg") return jpegSize(bytes);
  if (type === "image/gif") return gifSize(bytes);
  if (type === "image/webp") return webpSize(bytes);
  return undefined;
}

function pngSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG" || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifSize(bytes: Buffer): { width: number; height: number } | undefined {
  const signature = bytes.toString("ascii", 0, 6);
  if (bytes.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) return undefined;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function jpegSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return undefined;
    const startOfFrame = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
    if (startOfFrame) return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    offset += 2 + length;
  }
  return undefined;
}

function webpSize(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 20 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const end = bytes.readUInt32LE(4) + 8;
  if (end > bytes.length || end < 20) return undefined;
  for (let offset = 12; offset + 8 <= end;) {
    const kind = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > end) return undefined;
    if (kind === "VP8X" && length >= 10) return { width: 1 + bytes.readUIntLE(start + 4, 3), height: 1 + bytes.readUIntLE(start + 7, 3) };
    if (kind === "VP8 " && length >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      return { width: bytes.readUInt16LE(start + 6) & 0x3fff, height: bytes.readUInt16LE(start + 8) & 0x3fff };
    }
    if (kind === "VP8L" && length >= 5 && bytes[start] === 0x2f) {
      const bits = bytes.readUInt32LE(start + 1);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    offset = start + length + (length % 2);
  }
  return undefined;
}
