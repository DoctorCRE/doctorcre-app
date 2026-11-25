const signOffs = [
  "regards",
  "best regards",
  "kind regards",
  "warm regards",
  "warmest regards",
  "best",
  "thanks",
  "thanks so much",
  "thanks again",
  "thank you",
  "many thanks",
  "sincerely",
  "cheers",
  "respectfully",
  "saludos",
  "un saludo",
  "atentamente",
  "cordialement",
  "bien cordialement",
  "bien à vous",
  "mit freundlichen grüßen",
  "freundliche grüße",
  "viele grüße",
  "beste grüße",
  "cordiali saluti",
  "atenciosamente",
];
// Punctuation or a line end after the phrase, so "Thanks for the tour." stays a sentence.
const signOff = new RegExp(String.raw`^(?:${signOffs.join("|")})(?:[,.!]|(?=[^\S\n]*(?:\n|$)))\s*`, "iu");
const reachableSource = String.raw`\(?\b\d{3}\)?[\s.-]*\d{3}[\s.-]\d{4}\b|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|co|io|us)\b(?:\/\S*)?`;
const reachable = new RegExp(reachableSource, "i");
const everyReachable = new RegExp(reachableSource, "gi");
const contactLabel =
  /\b(?:(?:phone|tel|cell|mobile|fax|office|direct|email|e-mail|web|ext|x)\b\s*[:.]?|[pfmcote]\s*[:.)])/gi;
const lowercaseWord = /(?:^|[\s,|·•/(])(?!(?:of|and|the|at|for|in|on|by|de|la)\b)[a-z]/;
// Bodies decoded before line breaks were kept are one line, so a sentence end also starts a new part.
const sentenceOrLineBreak = /(?<=[.?!])\s+|\s*\n\s*/g;

// Sign-offs, names, titles, companies, addresses and contact details have no lowercase words beyond small joiners; sentences do.
const contactShaped = (part: string) => {
  const rest = part.replace(signOff, "").replace(everyReachable, "").replace(contactLabel, "");
  return !/[?!]$/.test(rest) && !lowercaseWord.test(rest);
};

function senderName(rest: string, sender: string | null) {
  const full = sender?.trim();
  return [full, full?.split(/\s+/, 1)[0]].find(
    (candidate) => candidate && rest.startsWith(candidate) && !/[\p{L}\d]/u.test(rest.charAt(candidate.length)),
  );
}

function nameLength(rest: string, sender: string | null) {
  const [line = ""] = rest.split("\n", 1);
  if (line.length < rest.length && !reachable.test(line)) return line.length;
  return senderName(rest, sender)?.length ?? 0;
}

/** Where a signature that opens at `start` would fold: after its sign-off and name, or after the sender's name. */
function anchorEnd(body: string, start: number, sender: string | null): number | null {
  const rest = body.slice(start);
  const signedOff = rest.match(signOff)?.[0].length;
  if (signedOff !== undefined) return start + signedOff + nameLength(rest.slice(signedOff), sender);
  return senderName(rest, sender) ? start + nameLength(rest, sender) : null;
}

/** Folds the contact details after a message's sign-off or sender's name; with neither, or with writing after them, nothing folds. */
export function splitSignature(body: string, sender: string | null): { text: string; signature: string | null } {
  const breaks = [...body.matchAll(sentenceOrLineBreak)];
  const parts = [0, ...breaks.map(({ index, 0: gap }) => index + gap.length)].map((start, at) => ({
    start,
    text: body.slice(start, breaks[at]?.index),
  }));
  const tail = parts.slice(parts.map(({ text }) => contactShaped(text)).lastIndexOf(false) + 1);
  const foldAt = tail.map(({ start }) => anchorEnd(body, start, sender)).find((at): at is number => at !== null);
  if (foldAt === undefined) return { text: body, signature: null };
  const signature = body.slice(foldAt).trim();
  if ((signature.match(everyReachable)?.length ?? 0) < 2) return { text: body, signature: null };
  return { text: body.slice(0, foldAt).trimEnd(), signature };
}
