const signOff =
  /^(?:(?:(?:best|kind|warm|warmest) )?regards|best|thanks(?: so much| again)?|thank you|many thanks|sincerely|cheers|respectfully)\b[,.!]?\s*/i;
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

function nameLength(rest: string, sender: string | null) {
  const [line = ""] = rest.split("\n", 1);
  if (line.length < rest.length && !reachable.test(line)) return line.length;
  const name = [sender, sender?.split(/\s+/, 1)[0]].find(
    (name) => name && rest.toLowerCase().startsWith(name.toLowerCase()) && !/\w/.test(rest.charAt(name.length)),
  );
  return name?.length ?? 0;
}

/** Splits the contact block after a message's last sentence from the text a person wrote, keeping the sign-off and name. */
export function splitSignature(body: string, sender: string | null): { text: string; signature: string | null } {
  const breaks = [...body.matchAll(sentenceOrLineBreak)];
  const parts = [0, ...breaks.map(({ index, 0: gap }) => index + gap.length)].map((start, at) => ({
    start,
    text: body.slice(start, breaks[at]?.index),
  }));
  const tail = parts[parts.map(({ text }) => contactShaped(text)).lastIndexOf(false) + 1]?.start;
  if (tail === undefined) return { text: body, signature: null };
  const named = tail + (body.slice(tail).match(signOff)?.[0].length ?? 0);
  const foldAt = named + nameLength(body.slice(named), sender?.trim() || null);
  const signature = body.slice(foldAt).trim();
  if ((signature.match(everyReachable)?.length ?? 0) < 2) return { text: body, signature: null };
  return { text: body.slice(0, foldAt).trimEnd(), signature };
}
