export function sourceExcerptText(text: string): string {
  if (!text.includes("&")) return text.replaceAll("\uFEFF", "");

  const decoder = document.createElement("textarea");
  // Keep literal angle brackets in the text passed to the browser's entity decoder.
  decoder.innerHTML = text.replaceAll("<", "&lt;");
  return decoder.textContent.replaceAll("\uFEFF", "");
}
