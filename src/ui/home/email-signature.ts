const signOff =
  /^(?:best|(?:(?:best|kind|warm|warmest) )?regards|thanks(?: so much| again)?|thank you|many thanks|sincerely|cheers|respectfully)[,.!]?$/i;
const contactLine =
  /\(?\b\d{3}\)?[\s.-]*\d{3}[\s.-]\d{4}\b|[\w.+-]+@[\w-]+\.[a-z]{2,}|^(?:www\.|https?:\/\/)|^(?:phone|cell|mobile|fax|office|direct|tel|email|[pfmcote])\s*[:.]/i;
const postscript = /^p\.?\s?s\b/i;

/** Splits the contact lines under a sign-off and its name from the text a person wrote. */
export function splitSignature(body: string): { text: string; signature: string | null } {
  const lines = body.split("\n");
  const signedAt = lines.map((line) => signOff.test(line.trim())).lastIndexOf(true);
  if (signedAt < 0) return { text: body, signature: null };
  const name = lines.findIndex((line, index) => index > signedAt && line.trim());
  if (name < 0) return { text: body, signature: null };
  const block = lines.slice(name + 1).map((line) => line.trim());
  if (!block.some((line) => contactLine.test(line)) || block.some((line) => postscript.test(line)))
    return { text: body, signature: null };
  return { text: lines.slice(0, name + 1).join("\n"), signature: block.join("\n").trim() };
}
