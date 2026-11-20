export function emailSubject(value: string | null | undefined): string {
  const subject = value?.trim();
  return !subject || /^(?:\(no subject\)|no subject)$/i.test(subject) ? "(No subject)" : subject;
}

export function emailPlaceholderText(value: string): string {
  return value.replace(/\(no subject\)/gi, "(No subject)");
}
