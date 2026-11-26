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
// Phone separators include Unicode hyphens, which Outlook signatures often use.
const reachableSource = String.raw`\(?\b\d{3}\)?[\s.\-‐‑–]*\d{3}[\s.\-‐‑–]\d{4}\b|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:https?:\/\/|www\.)\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|co|io|us)\b(?:\/\S*)?`;
const reachable = new RegExp(reachableSource, "i");
const everyReachable = new RegExp(reachableSource, "gi");
const contactLabelSource = String.raw`\b(?:(?:phone|tel|cell|mobile|fax|office|direct|email|e-mail|web|ext|x)\b\s*[:.]?|[pfmcote]\s*[:.)])`;
const contactLabel = new RegExp(contactLabelSource, "gi");
const streetAddress = String.raw`\b\d{1,6}(?:[^\S\n]+[\w'.-]+){1,4}?[^\S\n]+(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pkwy|parkway|hwy|highway|pl|place|cir|circle)\b`;
const firstContactDetail = new RegExp(
  String.raw`(?:${contactLabelSource}[^\S\n]*)?(?:${reachableSource}|${streetAddress})`,
  "i",
);
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

/** A sign-off's name and title: its whole line when contact details start below it, else the words before the first one. */
function signerLength(rest: string) {
  const [line = ""] = rest.split("\n", 1);
  const contact = line.search(firstContactDetail);
  return contact === -1 ? line.length : line.slice(0, contact).replace(/[\s|·•,;:/(-]+$/u, "").length;
}

/** Where a signature that opens at `start` would fold: after its sign-off and name, or after the sender's name. */
function anchorEnd(body: string, start: number, sender: string | null): number | null {
  const rest = body.slice(start);
  const signedOff = rest.match(signOff)?.[0].length;
  if (signedOff !== undefined) return start + signedOff + signerLength(rest.slice(signedOff));
  const name = senderName(rest, sender);
  if (!name) return null;
  const [line = ""] = rest.split("\n", 1);
  return start + (line.length < rest.length && !reachable.test(line) ? line.length : name.length);
}

// A legal notice that opens a company's footer, such as "Notice: This communication is intended only for…".
// "Confidential:" counts only when it opens a standard disclaimer, never an authored remark such as "Confidential: price is 40/ft".
const legalNotice =
  /^(?:(?:confidentiality |legal |important )?notice|disclaimer)\s*:|^confidential(?:ity)?\s*:\s*(?:this|the (?:information|contents)|information)\b|^this (?:e-?mail|message|communication)\b[^\n]*\bintended (?:only |solely )?for\b/i;

/** Folds the contact details after a message's sign-off or sender's name, and the legal-notice paragraph right after them; writing after that paragraph stays visible, and with no contact details nothing folds. */
export function splitSignature(body: string, sender: string | null): { text: string; signature: string | null } {
  const footerAt = [...body.matchAll(/\n\s*(?=\S)/g)]
    .map(({ index, 0: gap }) => index + gap.length)
    .find((start) => legalNotice.test(body.slice(start)));
  if (footerAt !== undefined) {
    const { text, signature } = contactFold(body.slice(0, footerAt), sender);
    if (signature !== null) {
      const afterNotice = body.slice(footerAt);
      const noticeEnd = afterNotice.search(/\n\s*\n/);
      const notice = noticeEnd === -1 ? afterNotice : afterNotice.slice(0, noticeEnd);
      const authored = noticeEnd === -1 ? "" : afterNotice.slice(noticeEnd).trim();
      return { text: authored ? `${text}\n\n${authored}` : text, signature: `${signature}\n${notice.trim()}` };
    }
  }
  return contactFold(body, sender);
}

function contactFold(body: string, sender: string | null): { text: string; signature: string | null } {
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

const field = (names: string) => String.raw`[ \t>]*\*?(?:${names}):\*?[ \t]`;
// Where quoted history starts: an Outlook reply header (under its optional divider), an "On …, … wrote:" line, wrapped or not, or an Original Message divider.
const quotedHistory = new RegExp(
  [
    String.raw`^(?:[ \t]*_{8,}[ \t]*\n)?${field("From")}[^\n]*\n(?:${field("Sent|Date|To|Cc|Bcc")}[^\n]*\n){1,4}${field("Subject")}`,
    String.raw`^[ \t>]*On [^\n]*\d[^\n]*(?:\n[^\n]*)?\bwrote:[ \t]*$`,
    String.raw`^[ \t>]*-{2,}[ \t]*Original Message[ \t]*-{2,}`,
  ].join("|"),
  "im",
);

/** The app's one email cleanup: quoted history and then the signature fold under Show earlier text; a message that is all history stays visible. */
export function foldEmailBody(body: string, sender: string | null): { text: string; folded: string | null } {
  const historyAt = body.search(quotedHistory);
  const own = historyAt > 0 ? body.slice(0, historyAt).trimEnd() : body;
  if (!own.trim()) return { text: body, folded: null };
  const history = own === body ? null : body.slice(historyAt).trim();
  const { text, signature } = splitSignature(own, sender);
  return { text, folded: [signature, history].filter(Boolean).join("\n\n") || null };
}
