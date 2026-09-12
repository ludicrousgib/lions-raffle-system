import { useMemo } from "react";
import { formatDateTime, formatMoney, formatRanges } from "@/lib/raffle";
import { ticketLink, ticketQr } from "@/lib/ticket";

type Props = { name: string; organisationName: string; venueName: string; cause?: string; website?: string; numbers: number[]; amount: number; time: string; sample?: boolean; invalid?: boolean };
export function PrintedTicket({ name, organisationName, venueName, cause, website, numbers, amount, time, sample, invalid }: Props) {
  const link = ticketLink(website ?? "", name);
  const url = link?.url;
  const qr = useMemo(() => url ? ticketQr(url) : null, [url]);
  return <article className="receipt-ticket" aria-label={sample ? "Sample printed ticket" : "Customer ticket"}>
    {sample && <strong className="receipt-mark">SAMPLE — NOT VALID</strong>}
    {invalid && <strong className="receipt-mark">NOT VALID</strong>}
    <header><strong>{organisationName}</strong><h2>{name}</h2><div>{venueName}</div><time>{formatDateTime(time)}</time></header>
    <section className="receipt-numbers"><span>Your tickets</span><strong>{formatRanges(numbers)}</strong></section>
    <div className="receipt-individual" aria-label="Individual ticket numbers">{numbers.map(number => <span key={number}>{number}</span>)}</div>
    <div className="receipt-purchase">{numbers.length} tickets · {formatMoney(amount)}</div>
    <p>This {name} was run by {organisationName}{cause?.trim() ? ` to raise funds for ${cause.trim()}` : ""}.</p>
    {link && <><p>If you would like to know more, please visit <strong>{link.display}</strong> or scan the QR code below.</p>{qr && <svg role="img" aria-label={`Visit ${link.display}`} viewBox={`0 0 ${qr.size} ${qr.size}`} style={{ width: `${qr.widthMm}mm`, height: `${qr.widthMm}mm` }} shapeRendering="crispEdges"><rect width={qr.size} height={qr.size} fill="white" /><path d={qr.path} fill="black" /></svg>}</>}
    <p><strong>Thanks for your support!</strong></p>
  </article>;
}
