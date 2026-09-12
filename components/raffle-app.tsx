"use client";
/* eslint-disable react-hooks/refs -- confirmation callbacks execute only from later user events */

import { PrintedTicket } from "./printed-ticket";
import { createClient } from "@supabase/supabase-js";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Banknote,
  Building2,
  Check,
  ChevronRight,
  Clock3,
  History,
  LayoutDashboard,
  LockKeyhole,
  MapPin,
  Pencil,
  Plus,
  Printer,
  RotateCcw,
  Settings,
  ShieldCheck,
  Ticket,
  Trash2,
  TriangleAlert,
  Trophy,
  Users,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_ORGANISATION_NAME,
  type AppState,
  type Organisation,
  type Raffle,
  type RaffleDraft,
  type Venue,
  currentCandidate,
  defaultDraft,
  emptyState,
  formatDateTime,
  formatMoney,
  formatRanges,
  latestCompletedSaleForSeller,
  nextUnfilledPrize,
  raffleStats,
  validateDraft,
} from "@/lib/raffle";

type LiveResponse = { state: AppState; revision: number; serverNow: number; result?: string | null; error?: string; code?: string };
type Screen = "home" | "raffle-menu" | "create" | "edit" | "join" | "admin-pin" | "seller" | "confirm-sale" | "ticket" | "admin" | "overview" | "manage" | "history" | "summary";
type ConfirmState = { title: string; body: string; label: string; destructive?: boolean; action: () => void } | null;

class ClientCommandError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}

function clone<T>(value: T): T { return structuredClone(value); }

function Header({ eyebrow, title, onBack, action }: { eyebrow?: string; title: string; onBack?: () => void; action?: ReactNode }) {
  return (
    <header className="app-header">
      <div className="header-row">
        {onBack ? <button className="icon-button" onClick={onBack} aria-label="Go back"><ArrowLeft size={21} /></button> : <div className="brand-symbol" aria-hidden="true"><Ticket size={23} /></div>}
        <div className="header-title">{eyebrow && <span>{eyebrow}</span>}<h1>{title}</h1></div>
        <div className="header-action">{action}</div>
      </div>
    </header>
  );
}

function Button({ children, className = "", variant = "primary", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{children}</button>;
}

function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warning" | "success" }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

function StatusPill({ status }: { status: Raffle["status"] }) {
  const copy = status === "selling" ? "Selling" : status === "drawing" ? "Draw" : "Ended";
  return <span className={`status-pill status-${status}`}>{copy}</span>;
}

function ConfirmDialog({ value, onClose }: { value: ConfirmState; onClose: () => void }) {
  if (!value) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description">
        <div className={`dialog-icon ${value.destructive ? "dialog-icon-danger" : ""}`}>{value.destructive ? <TriangleAlert size={24} /> : <ShieldCheck size={24} />}</div>
        <h2 id="dialog-title">{value.title}</h2>
        <p id="dialog-description">{value.body}</p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant={value.destructive ? "danger" : "primary"} onClick={() => { value.action(); onClose(); }}>{value.label}</Button>
        </div>
      </div>
    </div>
  );
}

function StrongDeleteDialog({ raffle, onClose, onDelete }: { raffle: Raffle | null; onClose: () => void; onDelete: () => void }) {
  const [text, setText] = useState("");
  if (!raffle) return null;
  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="alertdialog" aria-modal="true">
        <div className="dialog-icon dialog-icon-danger"><TriangleAlert size={24} /></div>
        <h2>Delete raffle and all sales?</h2>
        <p>This permanently removes only <strong>{raffle.name}</strong>, including its sales, reservations, draw data and audit history. Other raffles are not affected.</p>
        <label className="field confirmation-field"><span>Type DELETE to confirm</span><input autoFocus value={text} onChange={(event) => setText(event.target.value)} autoComplete="off" /></label>
        <div className="dialog-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" disabled={text !== "DELETE"} onClick={onDelete}>Delete raffle</Button></div>
      </div>
    </div>
  );
}

function RaffleForm({ initial, organisations, venues, submitLabel, onSubmit, onCancel, onAddEntity }: {
  initial: RaffleDraft;
  organisations: Organisation[];
  venues: Venue[];
  submitLabel: string;
  onSubmit: (draft: RaffleDraft) => void;
  onCancel: () => void;
  onAddEntity: (type: "organisation" | "venue", name: string) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<RaffleDraft>(() => clone(initial));
  const [error, setError] = useState("");
  const [preview, setPreview] = useState(false);
  const [previewBundle, setPreviewBundle] = useState(0);
  const [previewTime] = useState(() => new Date().toISOString());
  const availableOrganisations = organisations.filter((item) => !item.archivedAt || item.id === draft.organisationId);
  const availableVenues = venues.filter((item) => !item.archivedAt || item.id === draft.venueId);

  function setBundle(index: number, field: "quantity" | "price", value: number) {
    setDraft((current) => ({ ...current, bundles: current.bundles.map((bundle, bundleIndex) => bundleIndex === index ? { ...bundle, [field]: value } : bundle) }));
  }
  async function quickAdd(type: "organisation" | "venue") {
    const name = window.prompt(`New ${type} name`);
    if (!name?.trim()) return;
    const entityId = await onAddEntity(type, name);
    if (entityId) setDraft((current) => ({ ...current, [type === "organisation" ? "organisationId" : "venueId"]: entityId }));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const validation = validateDraft(draft);
    if (validation) { setError(validation); return; }
    setError("");
    setPreview(true);
    window.scrollTo({ top: 0 });
  }
  if (preview) return <section className="ticket-preview-screen form-stack"><h2>Preview your ticket</h2><Notice>Sample ticket on 58 mm paper. Review the wording and QR code before saving.</Notice><label className="field"><span>Preview bundle</span><select value={previewBundle} onChange={(event) => setPreviewBundle(Number(event.target.value))}>{draft.bundles.map((bundle, index) => <option key={index} value={index}>{bundle.quantity} tickets for {formatMoney(bundle.price)}</option>)}</select></label><PrintedTicket name={draft.name} organisationName={organisations.find((item) => item.id === draft.organisationId)?.name ?? ""} venueName={venues.find((item) => item.id === draft.venueId)?.name ?? ""} cause={draft.cause} website={draft.website} numbers={Array.from({ length: draft.bundles[previewBundle].quantity }, (_, index) => draft.startingTicket + index)} amount={draft.bundles[previewBundle].price} time={previewTime} sample /><div className="form-actions"><Button variant="secondary" onClick={() => setPreview(false)}>Back to settings</Button><Button onClick={() => onSubmit(draft)}>{submitLabel}</Button></div></section>;
  return (
    <form className="form-stack" onSubmit={submit}>
      {error && <Notice tone="warning">{error}</Notice>}
      <label className="field"><span>Raffle name</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoComplete="off" /></label>
      <div className="entity-picker">
        <label className="field"><span>Organisation</span><select value={draft.organisationId} onChange={(event) => setDraft({ ...draft, organisationId: event.target.value })}><option value="">Choose organisation</option>{availableOrganisations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" className="inline-add" onClick={() => void quickAdd("organisation")}><Plus size={16} /> Add organisation</button>
      </div>
      <div className="entity-picker">
        <label className="field"><span>Venue</span><select value={draft.venueId} onChange={(event) => setDraft({ ...draft, venueId: event.target.value })}><option value="">Choose venue</option>{availableVenues.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <button type="button" className="inline-add" onClick={() => void quickAdd("venue")}><Plus size={16} /> Add venue</button>
      </div>
      <label className="field"><span>Fundraising cause (optional)</span><input maxLength={250} value={draft.cause ?? ""} onChange={(event) => setDraft({ ...draft, cause: event.target.value })} placeholder="e.g. local community projects" /></label>
      <label className="field"><span>Website (optional)</span><input maxLength={300} inputMode="url" value={draft.website ?? ""} onChange={(event) => setDraft({ ...draft, website: event.target.value })} placeholder="e.g. freetradeday.com.au" /></label>
      <div className="field-row">
        <label className="field"><span>4-digit PIN</span><input value={draft.pin} onChange={(event) => setDraft({ ...draft, pin: event.target.value.replace(/\D/g, "").slice(0, 4) })} inputMode="numeric" autoComplete="off" placeholder="••••" /></label>
        <label className="field"><span>Starting ticket</span><input type="number" min="1" value={draft.startingTicket || ""} onChange={(event) => setDraft({ ...draft, startingTicket: Number(event.target.value) })} inputMode="numeric" /></label>
      </div>
      <label className="field"><span>Number of prizes</span><input type="number" min="1" value={draft.prizeCount || ""} onChange={(event) => setDraft({ ...draft, prizeCount: Number(event.target.value) })} inputMode="numeric" placeholder="Required" /></label>
      <fieldset className="bundle-fieldset">
        <legend>Ticket bundles</legend><p>Three quick-sale buttons shown to every seller.</p>
        {draft.bundles.map((bundle, index) => <div className="bundle-input" key={index}><strong>Bundle {index + 1}</strong><label><span>Tickets</span><input type="number" min="1" value={bundle.quantity || ""} onChange={(event) => setBundle(index, "quantity", Number(event.target.value))} inputMode="numeric" /></label><label><span>Price $</span><input type="number" min="0.01" step="0.01" value={bundle.price || ""} onChange={(event) => setBundle(index, "price", Number(event.target.value))} inputMode="decimal" /></label></div>)}
      </fieldset>
      <div className="form-actions"><Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button><Button type="submit">Preview ticket</Button></div>
    </form>
  );
}

function RaffleIdentity({ raffle }: { raffle: Raffle }) {
  return <div className="raffle-identity"><span><Building2 size={15} /> {raffle.organisationName}</span><span><MapPin size={15} /> {raffle.venueName}</span></div>;
}

function Summary({ raffle }: { raffle: Raffle }) {
  const stats = raffleStats(raffle);
  return (
    <div className="summary-stack">
      <section className="summary-hero"><div className="trophy-disc"><Trophy size={29} /></div><p>Raffle complete</p><h2>{raffle.name}</h2><RaffleIdentity raffle={raffle} /><span>{formatDateTime(raffle.endedAt)}</span></section>
      <section className="stat-grid"><div><span>Valid tickets</span><strong>{stats.totalTickets.toLocaleString()}</strong></div><div><span>Expected sales</span><strong>{formatMoney(stats.expectedRevenue)}</strong></div><div><span>First ticket</span><strong>{raffle.startingTicket.toLocaleString()}</strong></div><div><span>Highest issued</span><strong>{raffle.highestIssued >= raffle.startingTicket ? raffle.highestIssued.toLocaleString() : "—"}</strong></div></section>
      <section className="panel"><h3>Prize winners</h3><div className="winner-summary">{Array.from({ length: raffle.prizeCount }, (_, index) => { const prize = index + 1; const winner = raffle.winners.find((item) => item.prizeNumber === prize); return <div key={prize}><span>Prize {prize}</span><strong>{winner ? `#${winner.ticketNumber}` : "Not filled"}</strong></div>; })}</div></section>
      <section className="panel"><h3>Raffle details</h3><dl className="detail-list"><div><dt>Created</dt><dd>{formatDateTime(raffle.createdAt)}</dd></div><div><dt>Ended</dt><dd>{formatDateTime(raffle.endedAt)}</dd></div><div><dt>Voided tickets</dt><dd>{stats.voidedTickets.toLocaleString()}</dd></div></dl></section>
      <section className="panel"><h3>Bundle breakdown</h3><div className="breakdown-list">{stats.bundleBreakdown.map((bundle) => <div key={bundle.id}><div><strong>{bundle.quantity} for {formatMoney(bundle.price)}</strong><span>{bundle.sales} {bundle.sales === 1 ? "sale" : "sales"} · {bundle.tickets} tickets</span></div><strong>{formatMoney(bundle.revenue)}</strong></div>)}</div></section>
    </div>
  );
}

export function RaffleApp() {
  const [state, setState] = useState<AppState>(emptyState);
  const [screen, setScreen] = useState<Screen>("home");
  const [selectedRaffleId, setSelectedRaffleId] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [sellerName, setSellerName] = useState(() => typeof window === "undefined" ? "" : window.localStorage.getItem("lions_seller_name") ?? "");
  const [pin, setPin] = useState("");
  const [formError, setFormError] = useState("");
  const [selectedBundleId, setSelectedBundleId] = useState("");
  const [selectedReservationId, setSelectedReservationId] = useState("");
  const [now, setNow] = useState(0);
  const [toast, setToast] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [strongDelete, setStrongDelete] = useState<Raffle | null>(null);
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const inFlight = useRef(false);
  const clockOffset = useRef(0);
  const retryRequest = useRef<{ signature: string; requestId: string } | null>(null);

  const accept = useCallback((data: LiveResponse) => {
    clockOffset.current = data.serverNow - Date.now();
    setNow(data.serverNow);
    setState(data.state);
    setConnectionError("");
  }, []);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    try {
      const response = await fetch("/api/raffle", { cache: "no-store" });
      const data: LiveResponse = await response.json();
      if (!response.ok) throw new Error(data.error);
      accept(data);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Connection lost. Reconnect before selling.");
    } finally { setHydrated(true); }
  }, [accept]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refresh(), 0);
    const refreshTimer = window.setInterval(refresh, 10000);
    const timer = window.setInterval(() => setNow(Date.now() + clockOffset.current), 1000);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const realtime = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
    const channel = realtime?.channel("lions-raffle-signals").on("postgres_changes", { event: "*", schema: "public", table: "raffle_signals" }, () => void refresh()).subscribe();
    return () => { window.clearTimeout(initialTimer); window.clearInterval(timer); window.clearInterval(refreshTimer); if (channel && realtime) void realtime.removeChannel(channel); };
  }, [refresh]);

  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(""), 3200); return () => window.clearTimeout(timer); } }, [toast]);

  const raffle = state.activeRaffles.find((item) => item.id === selectedRaffleId);
  const access = raffle ? state.accessByRaffle[raffle.id] : undefined;
  const deviceSeller = raffle?.sellers.find((seller) => seller.id === access?.sellerId);
  const stats = raffle ? raffleStats(raffle) : null;

  const send = useCallback(async (action: string, values: Record<string, unknown> = {}) => {
    if (inFlight.current) throw new ClientCommandError("Please wait for the current action to finish.");
    inFlight.current = true;
    setBusy(true);
    setFormError("");
    const payload = { action, raffleId: selectedRaffleId || undefined, ...values };
    const signature = JSON.stringify(payload);
    const requestId = retryRequest.current?.signature === signature ? retryRequest.current.requestId : crypto.randomUUID();
    retryRequest.current = { signature, requestId };
    try {
      const response = await fetch("/api/raffle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, requestId }) });
      const data: LiveResponse = await response.json();
      if (!response.ok) throw new ClientCommandError(data.error ?? "The action could not be saved.", data.code);
      retryRequest.current = null;
      accept(data);
      return data;
    } finally { inFlight.current = false; setBusy(false); }
  }, [accept, selectedRaffleId]);

  const run = useCallback(async (action: string, values: Record<string, unknown> = {}, onSuccess?: (data: LiveResponse) => void) => {
    try { const data = await send(action, values); onSuccess?.(data); }
    catch (error) { const message = error instanceof Error ? error.message : "The action could not be saved."; setFormError(message); setToast(message); }
  }, [send]);

  function goHome() { setScreen("home"); setSelectedRaffleId(""); setFormError(""); setPin(""); }
  function chooseRaffle(id: string) { setSelectedRaffleId(id); setScreen("raffle-menu"); setFormError(""); }
  async function quickAddEntity(type: "organisation" | "venue", name: string) {
    try { const data = await send("entity-create", { entityType: type, name }); return data.result ?? null; }
    catch (error) { const message = error instanceof Error ? error.message : "Could not add this item."; setFormError(message); setToast(message); return null; }
  }
  async function openAdmin() {
    if (access?.admin) { setScreen("admin"); return; }
    if (access?.pinRemembered) await run("admin", {}, () => setScreen("admin"));
    else setScreen("admin-pin");
  }

  if (!hydrated) return <main className="app-shell loading-shell"><div className="brand-loading">LIONS RAFFLES</div><p>Loading active raffles…</p></main>;

  function renderHome() {
    return <><Header eyebrow={DEFAULT_ORGANISATION_NAME} title="Active raffles" action={<Button className="header-create" onClick={() => setScreen("create")}><Plus size={17} /> Create</Button>} /><main className="page home-page">
      {state.activeRaffles.length ? <div className="active-list">{state.activeRaffles.map((item) => <button className="raffle-card" key={item.id} onClick={() => chooseRaffle(item.id)}><div className="raffle-card-top"><StatusPill status={item.status} /><span>{formatDateTime(item.createdAt)}</span></div><h2>{item.name}</h2><RaffleIdentity raffle={item} /><ChevronRight className="raffle-chevron" size={21} /></button>)}</div> : <section className="empty-hero"><div className="ticket-illustration"><Ticket size={38} /></div><span>No active raffles</span><h2>Ready for the next raffle?</h2><p>Create a raffle, select its organisation and venue, then share its four-digit PIN.</p><Button onClick={() => setScreen("create")}>Create raffle</Button></section>}
      <div className="home-links"><button className="history-link" onClick={() => setScreen("overview")}><span><LayoutDashboard size={20} /> Global overview</span><ChevronRight size={19} /></button><button className="history-link" onClick={() => setScreen("history")}><span><History size={20} /> Raffle history</span><span>{state.history.length}<ChevronRight size={19} /></span></button><button className="history-link" onClick={() => setScreen("manage")}><span><Settings size={20} /> Manage organisations & venues</span><ChevronRight size={19} /></button></div>
      <p className="demo-note"><span /> Live shared raffles · Printing is simulated</p>
    </main></>;
  }

  function renderRaffleMenu() {
    if (!raffle || !stats) return renderHome();
    return <><Header eyebrow="Active raffle" title={raffle.name} onBack={goHome} action={<StatusPill status={raffle.status} />} /><main className="page raffle-menu-page">
      <section className="active-card"><RaffleIdentity raffle={raffle} /><div className="active-total"><strong>{stats.totalTickets.toLocaleString()}</strong><span>valid tickets sold</span></div><small>Expected sales {formatMoney(stats.expectedRevenue)}</small></section>
      <section className="action-stack"><button className="path-card seller-path" onClick={() => setScreen(deviceSeller ? "seller" : "join")}><span className="path-icon"><Ticket size={25} /></span><span><strong>{deviceSeller ? `Continue as ${deviceSeller.name}` : "Join Raffle"}</strong><small>Sell ticket bundles</small></span><ChevronRight size={22} /></button><button className="path-card admin-path" onClick={() => void openAdmin()}><span className="path-icon"><Trophy size={25} /></span><span><strong>Admin / Draw</strong><small>Stats, settings and prizes</small></span><ChevronRight size={22} /></button></section>
      <Button className="wide-button" variant="ghost" onClick={goHome}><ArrowLeft size={18} /> Back to Raffles</Button>
    </main></>;
  }

  function renderCreate(editing = false) {
    const defaultOrganisation = state.organisations.find((item) => !item.archivedAt && item.name === DEFAULT_ORGANISATION_NAME) ?? state.organisations.find((item) => !item.archivedAt);
    const initial: RaffleDraft = editing && raffle ? { name: raffle.name, cause: raffle.cause ?? "", website: raffle.website ?? "", pin: "", organisationId: raffle.organisationId, venueId: raffle.venueId, startingTicket: raffle.startingTicket, prizeCount: raffle.prizeCount, bundles: raffle.bundles.map(({ quantity, price }) => ({ quantity, price })) } : { ...clone(defaultDraft), organisationId: defaultOrganisation?.id ?? "", venueId: "" };
    const save = async (draft: RaffleDraft, continueSameVenue = false) => {
      try {
        const data = await send(editing ? "edit" : "create", { draft, confirmDuplicate: continueSameVenue });
        setToast(editing ? "Settings saved." : "Raffle created.");
        if (editing) setScreen("admin"); else { setSelectedRaffleId(data.result ?? ""); setScreen("raffle-menu"); }
      } catch (error) {
        if (error instanceof ClientCommandError && error.code === "VENUE_IN_USE") setConfirm({ title: "Another active raffle uses this venue", body: error.message, label: "Continue anyway", action: () => void save(draft, true) });
        else { const message = error instanceof Error ? error.message : "Could not save the raffle."; setFormError(message); setToast(message); }
      }
    };
    return <><Header eyebrow={editing ? raffle?.name : "New raffle"} title={editing ? "Edit settings" : "Create raffle"} onBack={() => editing ? setScreen("admin") : goHome()} /><main className="page form-page">{formError && <Notice tone="warning">{formError}</Notice>}<RaffleForm key={editing ? raffle?.id : "new"} initial={initial} organisations={state.organisations} venues={state.venues} submitLabel={editing ? "Save settings" : "Create raffle"} onCancel={() => editing ? setScreen("admin") : goHome()} onSubmit={(draft) => void save(draft)} onAddEntity={quickAddEntity} /></main></>;
  }

  function renderJoin(admin = false) {
    if (!raffle) return renderHome();
    const pinRemembered = Boolean(access?.pinRemembered);
    const submitJoin = async (confirmDuplicate = false) => {
      try {
        await send(admin ? "admin" : "join", { pin: pinRemembered ? undefined : pin, name: sellerName, confirmDuplicate });
        if (!admin) window.localStorage.setItem("lions_seller_name", sellerName.trim());
        setPin(""); setFormError(""); setScreen(admin ? "admin" : "seller");
      } catch (error) {
        if (error instanceof ClientCommandError && error.code === "DUPLICATE_SELLER") setConfirm({ title: "Seller name already used", body: error.message, label: "Continue as same seller", action: () => void submitJoin(true) });
        else setFormError(error instanceof Error ? error.message : "Access could not be confirmed.");
      }
    };
    return <><Header eyebrow={raffle.name} title={admin ? "Admin access" : "Join raffle"} onBack={() => setScreen("raffle-menu")} /><main className="page access-page"><div className="access-icon">{admin ? <LockKeyhole size={30} /> : <Users size={30} />}</div><h2>{admin ? (pinRemembered ? "Access remembered" : "Enter the raffle PIN") : "Who is selling?"}</h2><p>{pinRemembered ? "This device already has PIN access for this raffle." : admin ? "Use the same four-digit PIN shared with sellers." : "Your name is remembered across raffles on this device."}</p><form onSubmit={(event) => { event.preventDefault(); void submitJoin(); }} className="form-stack access-form">{formError && <Notice tone="warning">{formError}</Notice>}{!admin && <label className="field"><span>Seller name</span><input autoFocus value={sellerName} onChange={(event) => setSellerName(event.target.value)} autoComplete="name" placeholder="e.g. Gabe" /></label>}{!pinRemembered && <label className="field"><span>4-digit PIN</span><input autoFocus={admin} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" autoComplete="one-time-code" placeholder="••••" /></label>}<Button type="submit">{admin ? "Open admin" : "Join and sell"}</Button></form></main></>;
  }

  function renderSeller() {
    if (!raffle || !deviceSeller || !stats) return renderRaffleMenu();
    const lastSale = latestCompletedSaleForSeller(raffle, deviceSeller.id);
    const ownActive = raffle.reservations.find((reservation) => reservation.sellerId === deviceSeller.id && reservation.status === "active" && new Date(reservation.expiresAt).getTime() > now);
    return <><Header eyebrow={raffle.name} title={`Hi, ${deviceSeller.name}`} onBack={goHome} action={<StatusPill status={raffle.status} />} /><main className="page seller-page"><RaffleIdentity raffle={raffle} /><section className="seller-total"><span>Tickets sold</span><strong>{stats.totalTickets.toLocaleString()}</strong><small>Valid tickets in this raffle</small></section>{raffle.status !== "selling" && <Notice tone="warning"><strong>Sales are paused.</strong> This raffle is in Draw mode; you can stay here and selling will return when the organiser changes it back.</Notice>}{ownActive && <button className="resume-card" onClick={() => { setSelectedReservationId(ownActive.id); setScreen("ticket"); }}><span><Clock3 size={21} /><strong>Unprinted reservation</strong></span><span>Open ticket <ChevronRight size={18} /></span></button>}<section className="bundle-section"><div className="section-heading"><div><span>Quick sale</span><h2>Choose a bundle</h2></div><Ticket size={24} /></div><div className="bundle-grid">{raffle.bundles.map((bundle, index) => <button key={bundle.id} disabled={raffle.status !== "selling" || Boolean(ownActive)} className={`bundle-button bundle-${index + 1}`} onClick={() => { setSelectedBundleId(bundle.id); setScreen("confirm-sale"); }}><strong>{bundle.quantity}</strong><span>tickets</span><small>{formatMoney(bundle.price)}</small></button>)}</div></section>{lastSale && <section className="panel last-sale"><div className="section-heading compact"><div><span>Your latest sale</span><h3>{formatRanges(lastSale.ticketNumbers)}</h3></div><Check size={21} /></div><div className="last-sale-meta"><span>{lastSale.quantity} tickets</span><span>{formatMoney(lastSale.amount)}</span><span>{formatDateTime(lastSale.completedAt)}</span></div><div className="button-row"><Button variant="secondary" onClick={() => { setSelectedReservationId(lastSale.id); setScreen("ticket"); }}><Printer size={18} /> Reprint</Button><Button variant="ghost" disabled={raffle.status !== "selling"} onClick={() => setConfirm({ title: "Void latest sale?", body: `Tickets ${formatRanges(lastSale.ticketNumbers)} will stop counting as sold and become available again.`, label: "Void sale", destructive: true, action: () => void run("void", { targetId: lastSale.id }) })}><Trash2 size={18} /> Void sale</Button></div></section>}<Button className="wide-button" variant="ghost" onClick={goHome}><ArrowLeft size={18} /> Back to Raffles</Button></main></>;
  }

  function renderSaleConfirmation() {
    if (!raffle || !deviceSeller) return renderRaffleMenu();
    const bundle = raffle.bundles.find((item) => item.id === selectedBundleId);
    if (!bundle) return renderSeller();
    return <><Header eyebrow={raffle.name} title="Confirm sale" onBack={() => setScreen("seller")} /><main className="page confirmation-page"><section className="confirm-ticket"><div className="confirm-ticket-icon"><Ticket size={34} /></div><span>Ticket bundle</span><strong>{bundle.quantity}</strong><h2>tickets</h2><div className="price-line">{formatMoney(bundle.price)}</div></section><Notice>Ticket numbers are reserved only when you press Confirm. The reservation lasts two minutes while you print.</Notice><div className="sticky-actions"><Button variant="secondary" onClick={() => setScreen("seller")}>Cancel</Button><Button onClick={() => void run("reserve", { targetId: bundle.id }, (data) => { setSelectedReservationId(data.result!); setScreen("ticket"); })}>Confirm sale</Button></div></main></>;
  }

  function renderTicket() {
    if (!raffle) return renderHome();
    const reservation = raffle.reservations.find((item) => item.id === selectedReservationId);
    if (!reservation) return renderSeller();
    const isActive = reservation.status === "active" && new Date(reservation.expiresAt).getTime() > now;
    const isCompleted = reservation.status === "completed";
    const seconds = Math.max(0, Math.ceil((new Date(reservation.expiresAt).getTime() - now) / 1000));
    const ticketTime = reservation.completedAt ?? reservation.createdAt;
    return <><Header eyebrow={isCompleted ? "Sale complete" : "Reserved"} title="Customer ticket" onBack={isCompleted ? () => setScreen("seller") : undefined} action={isActive ? <span className="countdown"><Clock3 size={15} /> {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span> : undefined} /><main className="page ticket-page">{!isActive && !isCompleted && <Notice tone="warning">This ticket is {reservation.status}. Its numbers are no longer valid for this purchase.</Notice>}<PrintedTicket name={raffle.name} organisationName={raffle.organisationName} venueName={raffle.venueName} cause={raffle.cause} website={raffle.website} numbers={reservation.ticketNumbers} amount={reservation.amount} time={ticketTime} invalid={!isActive && !isCompleted} />{isActive && <Notice tone="warning"><strong>Not sold yet.</strong> Printing completes and locks this sale.</Notice>}{isCompleted && <Notice tone="success"><Check size={18} /> Print simulated · sale locked</Notice>}<div className="ticket-actions">{isActive && <Button variant="secondary" onClick={() => void run("cancel", { targetId: reservation.id }, () => setScreen("seller"))}><X size={18} /> Cancel</Button>}{(isActive || isCompleted) && <Button onClick={() => void run("print", { targetId: reservation.id }, () => setToast(isCompleted ? "Reprint simulated." : "Print simulated — sale completed."))}><Printer size={19} /> {isCompleted ? "Reprint" : "Print"}</Button>}{!isActive && !isCompleted && <Button onClick={() => setScreen("seller")}>Back to selling</Button>}</div>{isCompleted && <Button className="done-button" variant="secondary" onClick={() => setScreen("seller")}>Done</Button>}{isActive && <Button variant="ghost" onClick={() => setToast("Print failed (simulation). The reservation stays active for retry until its timer ends.")}>Simulate failed print</Button>}</main></>;
  }

  function requestActiveDelete() {
    if (!raffle || !stats) return;
    if (raffle.reservations.some((sale) => Boolean(sale.completedAt))) { setStrongDelete(raffle); return; }
    setConfirm({ title: "Delete this active raffle?", body: `${raffle.name} has no completed sales. Its reservations and setup will be removed.`, label: "Delete raffle", destructive: true, action: () => void run("delete-active", {}, goHome) });
  }

  function renderAdmin() {
    if (!raffle || !stats) return renderHome();
    const unlocked = Boolean(access?.admin);
    const pending = raffle.reservations.filter((reservation) => reservation.status === "active" && new Date(reservation.expiresAt).getTime() > now);
    const candidate = currentCandidate(raffle);
    const nextPrize = nextUnfilledPrize(raffle);
    const allPrizesFilled = raffle.winners.length === raffle.prizeCount;
    const excluded = new Set(raffle.drawEvents.map((event) => event.ticketNumber));
    const eligibleCount = raffle.reservations.filter((sale) => sale.status === "completed").flatMap((sale) => sale.ticketNumbers).filter((ticket) => !excluded.has(ticket)).length;
    return <><Header eyebrow={raffle.name} title={unlocked ? "Admin / Draw" : "Raffle overview"} onBack={goHome} action={<StatusPill status={raffle.status} />} /><main className="page admin-page"><RaffleIdentity raffle={raffle} />{!unlocked && <Notice><strong>Read-only view.</strong> Expected sales and raffle progress are public. Enter the raffle PIN to use Admin / Draw controls.</Notice>}<section className="stat-grid admin-stats"><div className="stat-feature"><span>Valid tickets sold</span><strong>{stats.totalTickets.toLocaleString()}</strong></div><div className="stat-feature"><span>Expected sales</span><strong>{formatMoney(stats.expectedRevenue)}</strong></div><div><span>First ticket</span><strong>{raffle.startingTicket.toLocaleString()}</strong></div><div><span>Highest issued</span><strong>{raffle.highestIssued >= raffle.startingTicket ? raffle.highestIssued.toLocaleString() : "—"}</strong></div></section>{stats.missingNumbers.length > 0 && <Notice tone="warning"><div className="notice-title"><TriangleAlert size={19} /><strong>External draw range is unsafe</strong></div><p>Missing: {stats.missingRanges}. The built-in draw uses only valid sold tickets and remains safe.</p></Notice>}
      {raffle.status === "selling" ? <section className="draw-cta"><div><span>When selling is finished</span><h2>Start the draw</h2><p>Sales and voids pause until you return to Selling.</p></div>{pending.length > 0 && <Notice tone="warning">{pending.length} unprinted {pending.length === 1 ? "reservation is" : "reservations are"} still active.</Notice>}{unlocked ? <Button disabled={pending.length > 0 || stats.totalTickets === 0} onClick={() => void run("start")}><Trophy size={20} /> Start Draw</Button> : <Button onClick={() => void openAdmin()}><LockKeyhole size={18} /> Unlock Admin / Draw</Button>}</section> : <section className="draw-stage"><div className="draw-stage-head"><div><span>Drawing now</span><h2>{candidate ? `Prize ${candidate.prizeNumber}` : nextPrize ? `Prize ${nextPrize}` : "All prizes filled"}</h2></div>{unlocked && <Button variant="ghost" disabled={Boolean(candidate)} onClick={() => void run("selling")}>Return to Selling</Button>}</div>{candidate ? <div className="candidate-card"><span>Candidate ticket</span><strong>{candidate.ticketNumber}</strong><p>Wait for the ticket holder to claim this prize.</p>{unlocked && <div className="candidate-actions"><Button variant="secondary" onClick={() => void run("redraw", { targetId: candidate.id })}><RotateCcw size={18} /> Redraw</Button><Button onClick={() => void run("confirm", { targetId: candidate.id })}><Check size={19} /> Confirm winner</Button></div>}</div> : !allPrizesFilled ? <div className="draw-ready"><Trophy size={35} /><p>{eligibleCount ? `Ready to choose from ${eligibleCount} eligible tickets.` : "No eligible tickets remain. Return to Selling to add tickets."}</p>{unlocked && <Button disabled={eligibleCount === 0} onClick={() => void run("draw")}>Draw candidate</Button>}</div> : <div className="draw-ready complete"><Check size={35} /><h3>Every prize is filled</h3><p>Review the winners, then end the raffle.</p>{unlocked && <Button onClick={() => setConfirm({ title: "End this raffle?", body: "The organisation and venue names will be snapshotted and the raffle will move to History.", label: "End raffle", destructive: true, action: () => void run("end", {}, (data) => { setSelectedHistoryId(data.result!); setScreen("summary"); }) })}>End raffle</Button>}</div>}</section>}
      <section className="panel"><div className="section-heading compact"><div><span>Configured prizes</span><h3>{raffle.winners.length} of {raffle.prizeCount} confirmed</h3></div><Trophy size={21} /></div><div className="prize-list">{Array.from({ length: raffle.prizeCount }, (_, index) => { const prizeNumber = index + 1; const winner = raffle.winners.find((item) => item.prizeNumber === prizeNumber); return <div key={prizeNumber} className={winner ? "prize-filled" : ""}><span>Prize {prizeNumber}</span><strong>{winner ? `#${winner.ticketNumber}` : "Unfilled"}</strong>{winner && raffle.status === "drawing" && unlocked && <button aria-label={`Undo Prize ${prizeNumber} winner`} onClick={() => setConfirm({ title: `Undo Prize ${prizeNumber} winner?`, body: `Ticket #${winner.ticketNumber} will stay excluded.`, label: "Undo winner", destructive: true, action: () => void run("undo", { targetId: winner.id }) })}><RotateCcw size={17} /></button>}</div>; })}</div></section>
      <section className="panel"><div className="section-heading compact"><div><span>Sales mix</span><h3>Bundle breakdown</h3></div><Banknote size={21} /></div><div className="breakdown-list">{stats.bundleBreakdown.map((bundle) => <div key={bundle.id}><div><strong>{bundle.quantity} for {formatMoney(bundle.price)}</strong><span>{bundle.sales} {bundle.sales === 1 ? "sale" : "sales"} · {bundle.tickets} tickets</span></div><strong>{formatMoney(bundle.revenue)}</strong></div>)}</div></section>
      {unlocked && !raffle.settingsLocked && raffle.status === "selling" && <Button className="wide-button" variant="secondary" onClick={() => setScreen("edit")}><Pencil size={18} /> Edit raffle settings</Button>}{raffle.settingsLocked && <p className="locked-note"><LockKeyhole size={15} /> Settings, organisation and venue locked after the first completed sale</p>}{unlocked && <Button className="wide-button danger-outline" variant="ghost" onClick={requestActiveDelete}><Trash2 size={18} /> Delete active raffle</Button>}<Button className="wide-button" variant="ghost" onClick={goHome}><ArrowLeft size={18} /> Back to Raffles</Button></main></>;
  }

  function renderOverview() {
    const recent = state.history.slice(0, 5);
    const row = (item: Raffle, completed = false) => { const itemStats = raffleStats(item); return <button className="overview-row" key={item.id} onClick={() => completed ? (setSelectedHistoryId(item.id), setScreen("summary")) : (setSelectedRaffleId(item.id), setScreen("admin"))}><div><span>{completed ? "Ended" : <StatusPill status={item.status} />}</span><strong>{item.name}</strong><small>{item.organisationName} · {item.venueName}</small></div><div className="overview-numbers"><strong>{itemStats.totalTickets.toLocaleString()}</strong><span>tickets</span><strong>{formatMoney(itemStats.expectedRevenue)}</strong><span>expected</span></div><ChevronRight size={19} /></button>; };
    return <><Header eyebrow="Read-only" title="Global overview" onBack={goHome} /><main className="page overview-page"><section><div className="section-heading"><div><span>Live now</span><h2>Active raffles</h2></div><LayoutDashboard size={23} /></div><div className="overview-list">{state.activeRaffles.length ? state.activeRaffles.map((item) => row(item)) : <Notice>No active raffles.</Notice>}</div></section><section><div className="section-heading"><div><span>Latest results</span><h2>Recently completed</h2></div><History size={23} /></div><div className="overview-list">{recent.length ? recent.map((item) => row(item, true)) : <Notice>No completed raffles yet.</Notice>}</div></section></main></>;
  }

  function renderManage() {
    const renderEntities = (type: "organisation" | "venue", items: Array<Organisation | Venue>) => <section className="panel entity-panel"><div className="section-heading"><div><span>Shared directory</span><h2>{type === "organisation" ? "Organisations" : "Venues"}</h2></div><Button variant="secondary" onClick={async () => { const name = window.prompt(`New ${type} name`); if (name?.trim()) await quickAddEntity(type, name); }}><Plus size={16} /> Add</Button></div><div className="entity-list">{items.map((item) => { const activeUse = state.activeRaffles.some((raffleItem) => raffleItem[type === "organisation" ? "organisationId" : "venueId"] === item.id); const used = activeUse || state.history.some((raffleItem) => raffleItem[type === "organisation" ? "organisationId" : "venueId"] === item.id); return <article key={item.id} className={item.archivedAt ? "entity-archived" : ""}><div><strong>{item.name}</strong><span>{item.archivedAt ? "Archived" : activeUse ? "Used by an active raffle" : used ? "Used in raffle history" : "Unused"}</span></div><div className="entity-actions"><button aria-label={`Rename ${item.name}`} onClick={async () => { const name = window.prompt("Rename", item.name); if (name?.trim() && name.trim() !== item.name) await run("entity-rename", { entityType: type, entityId: item.id, name }); }}><Pencil size={16} /></button>{item.archivedAt ? <button aria-label={`Restore ${item.name}`} onClick={() => void run("entity-restore", { entityType: type, entityId: item.id })}><ArchiveRestore size={17} /></button> : used ? <button aria-label={`Archive ${item.name}`} disabled={activeUse} title={activeUse ? "Cannot archive while used by an active raffle" : "Archive"} onClick={() => setConfirm({ title: `Archive ${item.name}?`, body: "It will remain in Manage and in completed raffle history, but will be hidden from new raffle forms.", label: "Archive", action: () => void run("entity-archive", { entityType: type, entityId: item.id }) })}><Archive size={17} /></button> : <button aria-label={`Delete ${item.name}`} onClick={() => setConfirm({ title: `Delete ${item.name}?`, body: "This unused item will be permanently deleted.", label: "Delete", destructive: true, action: () => void run("entity-delete", { entityType: type, entityId: item.id }) })}><Trash2 size={17} /></button>}</div></article>; })}</div></section>;
    return <><Header eyebrow="Open management" title="Organisations & venues" onBack={goHome} /><main className="page manage-page"><Notice>Organisation names are unique. Venue names may repeat. Items already used by a raffle can be archived, but not deleted.</Notice>{renderEntities("organisation", state.organisations)}{renderEntities("venue", state.venues)}</main></>;
  }

  function renderHistory() {
    return <><Header eyebrow="Completed raffles" title="Raffle history" onBack={goHome} /><main className="page history-page">{state.history.length === 0 ? <section className="empty-history"><History size={38} /><h2>No completed raffles yet</h2><p>Ended raffles and their winners will appear here.</p></section> : <div className="history-list">{state.history.map((item) => { const itemStats = raffleStats(item); return <article className="history-card" key={item.id}><button className="history-main" onClick={() => { setSelectedHistoryId(item.id); setScreen("summary"); }}><span>{formatDateTime(item.endedAt)}</span><strong>{item.name}</strong><small>{item.organisationName} · {item.venueName}</small><small>{itemStats.totalTickets} tickets · {formatMoney(itemStats.expectedRevenue)} · {item.prizeCount} {item.prizeCount === 1 ? "prize" : "prizes"}</small></button><button className="history-delete" aria-label={`Delete ${item.name}`} onClick={() => setConfirm({ title: "Delete this completed raffle permanently?", body: `${item.name} and its complete summary will be removed from History.`, label: "Delete raffle", destructive: true, action: () => void run("delete-history", { raffleId: item.id }) })}><Trash2 size={19} /></button></article>; })}</div>}</main></>;
  }

  function renderSummary() {
    const selected = state.history.find((item) => item.id === selectedHistoryId);
    if (!selected) return renderHistory();
    return <><Header eyebrow="Raffle history" title="Final summary" onBack={() => setScreen("history")} /><main className="page summary-page"><Summary raffle={selected} /></main></>;
  }

  let content: ReactNode;
  switch (screen) {
    case "raffle-menu": content = renderRaffleMenu(); break;
    case "create": content = renderCreate(); break;
    case "edit": content = renderCreate(true); break;
    case "join": content = renderJoin(); break;
    case "admin-pin": content = renderJoin(true); break;
    case "seller": content = renderSeller(); break;
    case "confirm-sale": content = renderSaleConfirmation(); break;
    case "ticket": content = renderTicket(); break;
    case "admin": content = renderAdmin(); break;
    case "overview": content = renderOverview(); break;
    case "manage": content = renderManage(); break;
    case "history": content = renderHistory(); break;
    case "summary": content = renderSummary(); break;
    default: content = renderHome();
  }

  return <div className="app-shell">{connectionError && <div className="connection-banner" role="alert">{connectionError} Changes need a working internet connection.</div>}{formError && !["join", "admin-pin", "create", "edit"].includes(screen) && <div className="connection-banner" role="alert">{formError}</div>}<fieldset className="app-interactions" disabled={busy || Boolean(connectionError)}>{content}</fieldset>{busy && <div className="toast" role="status">Saving securely…</div>}{toast && <div className="toast" role="status">{toast}</div>}<ConfirmDialog value={confirm} onClose={() => setConfirm(null)} /><StrongDeleteDialog raffle={strongDelete} onClose={() => setStrongDelete(null)} onDelete={() => { setStrongDelete(null); void run("delete-active", { confirmDelete: "DELETE" }, goHome); }} /></div>;
}
