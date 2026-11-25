const signOff =
  /^(?:best|(?:(?:best|kind|warm|warmest) )?regards|thanks(?: so much| again)?|thank you|many thanks|sincerely|cheers|respectfully)[,.!]?$/i;
const reachableSource = String.raw`\(?\b\d{3}\)?[\s.-]*\d{3}[\s.-]\d{4}\b|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:https?:\/\/|www\.)\S+`;
const reachable = new RegExp(reachableSource, "i");
const everyReachable = new RegExp(reachableSource, "gi");
const contactLabel = /\b(?:(?:phone|tel|cell|mobile|fax|office|direct|email|e-mail|web)\b\s*[:.]?|[pfmcote]\s*[:.])/gi;
const lowercaseWord = /(?:^|[\s,|·•/(])(?!(?:of|and|the|at|for|in|on|by|de|la)\b)[a-z]/;

// Name, title, company, address and contact lines have no lowercase words beyond small joiners; sentences do.
const contactShaped = (line: string) =>
  line.length <= 80 &&
  !/[?!]$/.test(line) &&
  !lowercaseWord.test(line.replace(everyReachable, "").replace(contactLabel, ""));

/** Splits a trailing contact block under a sign-off and name from the text a person wrote. */
export function splitSignature(body: string): { text: string; signature: string | null } {
  const lines = body.split("\n");
  const signedAt = lines.map((line) => signOff.test(line.trim())).lastIndexOf(true);
  const name = lines.findIndex((line, index) => index > signedAt && line.trim());
  if (signedAt < 0 || name < 0) return { text: body, signature: null };
  const named = lines.slice(name).map((line) => line.trim());
  const [, ...block] = named;
  if (!named.filter(Boolean).every(contactShaped) || !block.some((line) => reachable.test(line)))
    return { text: body, signature: null };
  return { text: lines.slice(0, name + 1).join("\n"), signature: block.join("\n").trim() };
}
