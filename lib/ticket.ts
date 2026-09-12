import QRCode from "qrcode";

export function normaliseWebsite(value: string) {
  const input = value.trim();
  if (!input) return "";
  if (/\s/.test(input)) throw new Error("Enter a website without spaces.");
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname.includes(".")) throw new Error("Enter a valid http or https website.");
  if (url.href.length > 300) throw new Error("Keep the website under 300 characters.");
  return url.href;
}

export function ticketLink(website: string, eventName: string) {
  const normalised = normaliseWebsite(website);
  if (!normalised) return null;
  const url = new URL(normalised);
  const display = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  url.searchParams.set("utm_source", "raffle");
  url.searchParams.set("utm_medium", "qr");
  url.searchParams.set("utm_campaign", eventName.trim());
  return { display, url: url.href };
}

export function ticketQr(url: string) {
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  // Four-module quiet zone, whole printer dots per module, within 384 dots.
  const dots = Math.min(6, Math.floor(384 / (size + 8)));
  if (dots < 3) throw new Error("Website is too long for a readable ticket QR code. Use a shorter link.");
  let path = "";
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (qr.modules.get(y, x)) path += `M${x + 4} ${y + 4}h1v1h-1z`;
  }
  return { path, size: size + 8, widthMm: (size + 8) * dots / 8 };
}
