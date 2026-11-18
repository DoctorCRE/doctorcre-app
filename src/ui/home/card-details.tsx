import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { InboxClient, IncomingEmail } from "./inbox";
import { ReviewCard } from "./review-card";

type Props = Omit<ComponentProps<typeof ReviewCard>, "client"> & {
  client: InboxClient["review"];
  children: ReactNode;
};

export function CardDetails({ item, client, children, close, busy, confirmed }: Props) {
  const [email, setEmail] = useState<IncomingEmail | null>();
  const host = useRef<HTMLElement>(null);
  const editor = useMemo(
    () =>
      client &&
      ({
        ...client,
        async load(item, signal) {
          const review = await client.load(item, signal);
          if (review.kind === "reply_draft" && !signal?.aborted) setEmail(review.email);
          return review;
        },
      } satisfies NonNullable<InboxClient["review"]>),
    [client],
  );

  useEffect(() => {
    if (!editor) host.current?.focus();
  }, [editor]);

  return (
    <section
      className="home-card-details home-inline-review"
      ref={host}
      tabIndex={-1}
      aria-label={`Details for ${item.title}`}
      onKeyDown={(event) => {
        if (!editor && event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
    >
      {!editor && (
        <header>
          <h4>{item.title}</h4>
          <button type="button" onClick={close}>
            Close review
          </button>
        </header>
      )}
      {children}
      {email && (
        <section aria-label="Incoming email">
          <h4>Incoming email excerpt</h4>
          {email.sender && <p>From: {email.sender}</p>}
          {email.subject && <p>{email.subject}</p>}
          <blockquote>{email.excerpt}</blockquote>
        </section>
      )}
      {email === null && <p>The original email is unavailable.</p>}
      {editor && <ReviewCard item={item} client={editor} close={close} busy={busy} confirmed={confirmed} />}
    </section>
  );
}
