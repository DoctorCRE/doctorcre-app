import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type CardSectionProps, mountCardSection, OpenControl, OpenedFrame, useRead } from "./client-deals.tsx";
import {
  Box,
  Branch,
  type DiagramClient,
  dated,
  Glyph,
  type GlyphMark,
  type Line,
  WORD,
  withRole,
} from "./deal-diagram.tsx";
import { RELATIONSHIP_SHAPES } from "./relationship-shapes.ts";

type Partner = "joe" | "dell";
interface Party {
  party_id: string;
  name: string;
}
interface DealRef {
  id: string;
  name: string;
  open: boolean;
}
interface Introduction {
  introduction_id: string;
  client: Party;
  deal: DealRef | null;
  introduced_on: string | null;
}
// The engine's read of one vendor, GET /api/engine/vendors/{id}/relationships.
export interface VendorRelationships {
  relationship_partner: Partner | null;
  sent_us: Introduction[];
  we_sent_them: (Introduction & { introduced_by: Partner | null; chosen: boolean })[];
  worked_with: (DealRef & { client: Party | null })[];
  knows: Party[];
  can_introduce: Party[];
  counts: { sent_us: number; we_sent_them: number; chosen: number; knows: number };
}

interface Node {
  key: string;
  mark: GlyphMark;
  name: string;
  caption: ReactNode;
  // Shown only in the opened view.
  detail: string | null;
  line: Line;
}
type Side = "left" | "right" | "below";
interface Group {
  label: string;
  side: Side;
  line: Line;
  nodes: Node[];
}

const PARTNER: Record<Partner, string> = { joe: "Joe", dell: "Dell" };
const word = (text: string) => <span className="deal-diagram-word">{text}</span>;
const party =
  (mark: GlyphMark, caption: ReactNode) =>
  (p: Party): Node => ({
    key: p.party_id,
    mark,
    name: p.name,
    caption,
    detail: null,
    line: "plain",
  });

function introducedBy(by: Partner | null, on: string | null) {
  if (!by) return "Introduced by: not recorded";
  return dated(`${PARTNER[by]} introduced`, on) || `${PARTNER[by]} introduced`;
}

function groupsOf(read: VendorRelationships): Group[] {
  const groups: Group[] = [
    {
      label: "Sent us",
      side: "left",
      line: "plain",
      nodes: read.sent_us.map(({ introduction_id, client, deal, introduced_on }) => ({
        key: introduction_id,
        mark: deal ? "chosen" : "introduced",
        name: client.name,
        caption: deal ? withRole(deal.name, word(deal.open ? "Open deal" : "Deal closed")) : "No deal yet",
        detail: dated("Sent", introduced_on),
        line: deal ? "chosen" : "plain",
      })),
    },
    {
      label: "We sent them",
      side: "right",
      line: "plain",
      nodes: read.we_sent_them.map(({ introduction_id, client, deal, chosen, introduced_by, introduced_on }) => ({
        key: introduction_id,
        mark: chosen ? "chosen" : "introduced",
        name: client.name,
        caption: withRole(deal?.name ?? null, word(chosen ? WORD.chosen : WORD.introduced)),
        detail: introducedBy(introduced_by, introduced_on),
        line: chosen ? "chosen" : "plain",
      })),
    },
    {
      label: "On deals, source not recorded",
      side: "right",
      line: "dashed",
      nodes: read.worked_with.map((deal) => ({
        key: deal.id,
        mark: "onDeal",
        name: deal.client?.name ?? deal.name,
        caption: withRole(deal.client && deal.name, word(WORD.onDeal)),
        detail: null,
        line: "dashed",
      })),
    },
    { label: "Knows", side: "below", line: "plain", nodes: read.knows.map(party("knows", null)) },
    {
      label: "Can introduce us to",
      side: "below",
      line: "dashed",
      nodes: read.can_introduce.map(party("offered", "Offered")),
    },
  ];
  return groups.filter((group) => group.nodes.length > 0);
}

const TONE: Partial<Record<GlyphMark, string>> = { knows: "person" };

function GroupBranch({ group, large }: { group: Group; large: boolean }) {
  return (
    <li data-line={group.line} className="deal-diagram-junction">
      <span>
        {group.label} <span className="vendor-diagram-count">{group.nodes.length}</span>
      </span>
      <ul data-line={group.line}>
        {group.nodes.map((node) => (
          <Branch key={node.key} line={node.line}>
            <Box
              tone={TONE[node.mark] ?? node.mark}
              lead={<Glyph mark={node.mark} />}
              name={node.name}
              caption={node.caption}
              detail={large ? node.detail : null}
            />
          </Branch>
        ))}
      </ul>
    </li>
  );
}

function PartnerBox({ partner }: { partner: Partner }) {
  const lead = (
    <span className="deal-diagram-initial" aria-hidden="true">
      {PARTNER[partner][0]}
    </span>
  );
  return <Box tone="person" lead={lead} name={PARTNER[partner]} caption="Relationship partner" />;
}

interface DiagramProps {
  vendor: DiagramClient;
  partner: Partner | null;
  groups: Group[];
}

function RelationshipShape({ relationship }: { relationship: DiagramClient["relationship"] }) {
  if (!relationship) return null;
  return (
    <svg
      className="rel-shape"
      data-relationship={relationship}
      viewBox="0 0 12 12"
      aria-hidden="true"
      // The shapes are this app's own fixed markup, shared with the Vendors table.
      ref={(svg) => {
        if (svg) svg.innerHTML = RELATIONSHIP_SHAPES[relationship];
      }}
    />
  );
}

const top = (vendor: DiagramClient, lead: ReactNode = null) => (
  <Box tone="client" lead={lead} name={vendor.name} caption="Vendor" />
);

function CardTree({ vendor, partner, groups }: DiagramProps) {
  return (
    <div className="deal-diagram vendor-diagram">
      {top(vendor)}
      <ul>
        {partner && (
          <Branch line="plain">
            <PartnerBox partner={partner} />
          </Branch>
        )}
        {groups.map((group) => (
          <GroupBranch key={group.label} group={group} large={false} />
        ))}
      </ul>
    </div>
  );
}

// Curves from the vendor to every box beside it, measured after layout.
function useLinks(frame: RefObject<HTMLDivElement | null>, vendor: RefObject<HTMLDivElement | null>) {
  const [links, setLinks] = useState<{ d: string; line: string }[]>([]);
  useLayoutEffect(() => {
    const root = frame.current;
    const hub = vendor.current;
    if (!root || !hub) return;
    const draw = () => {
      const origin = root.getBoundingClientRect();
      const from = hub.getBoundingClientRect();
      const y1 = from.top + from.height / 2 - origin.top;
      const items = root.querySelectorAll<HTMLElement>("[data-side] li:not(.deal-diagram-junction)");
      setLinks(
        [...items].map((item) => {
          const box = item.getBoundingClientRect();
          const left = item.closest("[data-side]")?.getAttribute("data-side") === "left";
          const x1 = (left ? from.left : from.right) - origin.left;
          const x2 = (left ? box.right : box.left) - origin.left;
          const y2 = box.top + box.height / 2 - origin.top;
          const bend = (x1 + x2) / 2;
          return { d: `M${x1} ${y1}C${bend} ${y1} ${bend} ${y2} ${x2} ${y2}`, line: item.dataset.line ?? "plain" };
        }),
      );
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(root);
    return () => observer.disconnect();
  }, [frame, vendor]);
  return links;
}

function SidesView({ vendor, partner, groups }: DiagramProps) {
  const frame = useRef<HTMLDivElement>(null);
  const hub = useRef<HTMLDivElement>(null);
  const links = useLinks(frame, hub);
  const side = (name: Side) =>
    groups.filter((group) => group.side === name).map((group) => <GroupBranch key={group.label} group={group} large />);
  const below = side("below");
  return (
    <div className="deal-diagram vendor-diagram" data-size="sides" ref={frame}>
      <svg className="vendor-diagram-links" aria-hidden="true">
        {links.map((link) => (
          <path key={link.d} d={link.d} data-line={link.line} />
        ))}
      </svg>
      <ul data-side="left">{side("left")}</ul>
      <div className="vendor-diagram-middle">
        {partner && (
          <div className="vendor-diagram-partner">
            <PartnerBox partner={partner} />
          </div>
        )}
        <div ref={hub}>{top(vendor, <RelationshipShape relationship={vendor.relationship} />)}</div>
        {below.length > 0 && <ul>{below}</ul>}
      </div>
      <ul data-side="right">{side("right")}</ul>
    </div>
  );
}

function VendorRelationshipsSection({ subject, load, stage }: CardSectionProps<VendorRelationships>) {
  const [read, retry] = useRead(load);
  const [opened, setOpened] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (read.state === "loading") return <p className="record-note">Loading relationships…</p>;
  if (read.state === "failed")
    return (
      <>
        <h3>Relationships</h3>
        <p className="record-note">
          Couldn't load relationships.{" "}
          <button type="button" className="client-deals-retry" onClick={retry}>
            Try again
          </button>
        </p>
      </>
    );
  const groups = groupsOf(read.value);
  if (groups.length === 0) return null;
  const { counts } = read.value;
  const diagram = { vendor: subject, partner: read.value.relationship_partner, groups };
  const close = () => {
    setOpened(false);
    opener.current?.focus();
  };
  return (
    <>
      <header className="client-deal-head">
        <h3>Relationships</h3>
        <OpenControl
          label={`Open ${subject.name}'s relationships large`}
          expanded={opened}
          opener={opener}
          open={() => setOpened(true)}
        />
      </header>
      <p className="vendor-diagram-counts">
        {(
          [
            ["Sent us", counts.sent_us],
            ["We sent them", counts.we_sent_them],
            ["Chosen", counts.chosen],
            ["Knows", counts.knows],
          ] as const
        ).map(([label, count]) => (
          <span key={label}>
            {label} <b>{count}</b>
          </span>
        ))}
      </p>
      <CardTree {...diagram} />
      {opened &&
        createPortal(
          <OpenedFrame
            label={`${subject.name} relationships`}
            title={
              <>
                <b>{subject.name}</b>
                <span>Relationships</span>
              </>
            }
            close={close}
          >
            <SidesView {...diagram} />
          </OpenedFrame>,
          stage,
        )}
    </>
  );
}

export const mountVendorRelationships = (host: HTMLElement, props: CardSectionProps<VendorRelationships>) =>
  mountCardSection(host, VendorRelationshipsSection, props);
