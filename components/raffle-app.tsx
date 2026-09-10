"use client";

import {
  ArrowLeft,
  Banknote,
  Check,
  ChevronRight,
  Clock3,
  History,
  LockKeyhole,
  Pencil,
  Printer,
  RotateCcw,
  ShieldCheck,
  Ticket,
  Trash2,
  TriangleAlert,
  Trophy,
  Users,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import {
  CLUB_NAME,
  DemoState,
  Raffle,
  RaffleDraft,
  cancelReservation,
  completePrint,
  confirmWinner,
  createRaffle,
  currentCandidate,
  defaultDraft,
  drawCandidate,
  emptyState,
  endRaffle,
  expireReservations,
  formatDateTime,
  formatMoney,
  formatRanges,
  latestCompletedSaleForSeller,
  nextUnfilledPrize,
  raffleStats,
  redrawCandidate,
  reserveBundle,
  returnToSelling,
  startDraw,
  undoWinner,
  validateDraft,
  voidLatestSale,
} from "@/lib/raffle";

const STORAGE_KEY = "lions-raffle-demo-v1";
type Screen = "home" | "create" | "edit" | "join" | "admin-pin" | "seller" | "confirm-sale" | "ticket" | "admin" | "history" | "summary";

type ConfirmState = {
  title: string;
  body: string;
  label: string;
  destructive?: boolean;
  action: () => void;
} | null;

type WebMcpTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};

declare global {
  interface Document {
    modelContext?: {
      registerTool: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => void | Promise<void>;
    };
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function Header({ eyebrow, title, onBack, action }: { eyebrow?: string; title: string; onBack?: () => void; action?: ReactNode }) {
  return (
    <header className="app-header">
      <div className="header-row">
        {onBack ? (
          <button className="icon-button" onClick={onBack} aria-label="Go back">
            <ArrowLeft size={21} />
          </button>
        ) : <div className="brand-symbol" aria-hidden="true"><Ticket size={23} /></div>}
        <div className="header-title">
          {eyebrow && <span>{eyebrow}</span>}
          <h1>{title}</h1>
        </div>
        <div className="header-action">{action}</div>
      </div>
    </header>
  );
}

function Button({ children, className = "", variant = "primary", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return (
    <button className={`button button-${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}

function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warning" | "success" }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

function StatusPill({ status }: { status: Raffle["status"] }) {
  const copy = status === "selling" ? "Selling" : status === "drawing" ? "Draw mode" : "Ended";
  return <span className={`status-pill status-${status}`}>{copy}</span>;
}

function ConfirmDialog({ value, onClose }: { value: ConfirmState; onClose: () => void }) {
  if (!value) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-description">
        <div className={`dialog-icon ${value.destructive ? "dialog-icon-danger" : ""}`}>
          {value.destructive ? <TriangleAlert size={24} /> : <ShieldCheck size={24} />}
        </div>
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

function RaffleForm({ initial, submitLabel, onSubmit, onCancel }: { initial: RaffleDraft; submitLabel: string; onSubmit: (draft: RaffleDraft) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<RaffleDraft>(() => clone(initial));
  const [error, setError] = useState("");

  function setBundle(index: number, field: "quantity" | "price", value: number) {
    setDraft((current) => ({
      ...current,
      bundles: current.bundles.map((bundle, bundleIndex) => bundleIndex === index ? { ...bundle, [field]: value } : bundle),
    }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const validation = validateDraft(draft);
    if (validation) {
      setError(validation);
      return;
    }
    onSubmit(draft);
  }

  return (
    <form className="form-stack" onSubmit={submit}>
      {error && <Notice tone="warning">{error}</Notice>}
      <label className="field">
        <span>Raffle name</span>
        <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoComplete="off" />
      </label>
      <div className="field-row">
        <label className="field">
          <span>4-digit PIN</span>
          <input value={draft.pin} onChange={(event) => setDraft({ ...draft, pin: event.target.value.replace(/\D/g, "").slice(0, 4) })} inputMode="numeric" autoComplete="off" placeholder="••••" />
        </label>
        <label className="field">
          <span>Starting ticket</span>
          <input type="number" min="1" value={draft.startingTicket || ""} onChange={(event) => setDraft({ ...draft, startingTicket: Number(event.target.value) })} inputMode="numeric" />
        </label>
      </div>
      <label className="field">
        <span>Number of prizes</span>
        <input type="number" min="1" value={draft.prizeCount || ""} onChange={(event) => setDraft({ ...draft, prizeCount: Number(event.target.value) })} inputMode="numeric" placeholder="Required" />
      </label>
      <fieldset className="bundle-fieldset">
        <legend>Ticket bundles</legend>
        <p>Three quick-sale buttons shown to every seller.</p>
        {draft.bundles.map((bundle, index) => (
          <div className="bundle-input" key={index}>
            <strong>Bundle {index + 1}</strong>
            <label>
              <span>Tickets</span>
              <input type="number" min="1" value={bundle.quantity || ""} onChange={(event) => setBundle(index, "quantity", Number(event.target.value))} inputMode="numeric" />
            </label>
            <label>
              <span>Price $</span>
              <input type="number" min="0.01" step="0.01" value={bundle.price || ""} onChange={(event) => setBundle(index, "price", Number(event.target.value))} inputMode="decimal" />
            </label>
          </div>
        ))}
      </fieldset>
      <div className="form-actions">
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}

function Summary({ raffle }: { raffle: Raffle }) {
  const stats = raffleStats(raffle);
  return (
    <div className="summary-stack">
      <section className="summary-hero">
        <div className="trophy-disc"><Trophy size={29} /></div>
        <p>Raffle complete</p>
        <h2>{raffle.name}</h2>
        <span>{formatDateTime(raffle.endedAt)}</span>
      </section>
      <section className="stat-grid">
        <div><span>Valid tickets</span><strong>{stats.totalTickets.toLocaleString()}</strong></div>
        <div><span>Expected sales</span><strong>{formatMoney(stats.expectedRevenue)}</strong></div>
        <div><span>First ticket</span><strong>{raffle.startingTicket.toLocaleString()}</strong></div>
        <div><span>Highest issued</span><strong>{raffle.highestIssued >= raffle.startingTicket ? raffle.highestIssued.toLocaleString() : "—"}</strong></div>
      </section>
      <section className="panel">
        <h3>Prize winners</h3>
        <div className="winner-summary">
          {Array.from({ length: raffle.prizeCount }, (_, index) => {
            const prize = index + 1;
            const winner = raffle.winners.find((item) => item.prizeNumber === prize);
            return <div key={prize}><span>Prize {prize}</span><strong>{winner ? `#${winner.ticketNumber}` : "Not filled"}</strong></div>;
          })}
        </div>
      </section>
      <section className="panel">
        <h3>Raffle details</h3>
        <dl className="detail-list">
          <div><dt>Created</dt><dd>{formatDateTime(raffle.createdAt)}</dd></div>
          <div><dt>Ended</dt><dd>{formatDateTime(raffle.endedAt)}</dd></div>
          <div><dt>Voided tickets</dt><dd>{stats.voidedTickets.toLocaleString()}</dd></div>
        </dl>
      </section>
      <section className="panel">
        <h3>Bundle breakdown</h3>
        <div className="breakdown-list">
          {stats.bundleBreakdown.map((bundle) => (
            <div key={bundle.id}>
              <div><strong>{bundle.quantity} for {formatMoney(bundle.price)}</strong><span>{bundle.sales} {bundle.sales === 1 ? "sale" : "sales"} · {bundle.tickets} tickets</span></div>
              <strong>{formatMoney(bundle.revenue)}</strong>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function RaffleApp() {
  const [state, setState] = useState<DemoState>(emptyState);
  const [screen, setScreen] = useState<Screen>("home");
  const [hydrated, setHydrated] = useState(false);
  const [sellerName, setSellerName] = useState("");
  const [pin, setPin] = useState("");
  const [formError, setFormError] = useState("");
  const [selectedBundleId, setSelectedBundleId] = useState("");
  const [selectedReservationId, setSelectedReservationId] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const [now, setNow] = useState(0);
  const [toast, setToast] = useState("");
  const [confirm, setConfirm] = useState<ConfirmState>(null);

  useEffect(() => {
    const load = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) setState(JSON.parse(saved) as DemoState);
      } catch {
        setToast("Saved demo data could not be loaded.");
      } finally {
        setHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(load);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, hydrated]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
      setState((current) => {
        if (!current.activeRaffle) return current;
        const next = clone(current);
        const expired = expireReservations(next.activeRaffle!, new Date());
        return expired ? next : current;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const register = (tool: WebMcpTool) => {
      try {
        void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined);
      } catch {
        // WebMCP is progressive enhancement; the visible app remains fully usable.
      }
    };
    register({
      name: "read_lions_raffle_status",
      title: "Read raffle status",
      description: "Read the active Lions raffle name, mode, valid tickets sold, expected sales and draw progress without changing it.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => {
        if (!state.activeRaffle) return { active: false, completedRaffles: state.history.length };
        const currentStats = raffleStats(state.activeRaffle);
        return {
          active: true,
          name: state.activeRaffle.name,
          status: state.activeRaffle.status,
          validTicketsSold: currentStats.totalTickets,
          expectedSales: currentStats.expectedRevenue,
          confirmedPrizes: state.activeRaffle.winners.length,
          prizeCount: state.activeRaffle.prizeCount,
          activeUnprintedReservations: state.activeRaffle.reservations.filter((item) => item.status === "active" && new Date(item.expiresAt).getTime() > Date.now()).length,
        };
      },
    });
    register({
      name: "open_lions_raffle_history",
      title: "Open raffle history",
      description: "Open the read-only raffle history screen in the visible app.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: () => {
        setScreen("history");
        return { opened: true, completedRaffles: state.history.length };
      },
    });
    return () => lifecycle.abort();
  }, [state]);

  const raffle = state.activeRaffle;
  const deviceSellerId = raffle ? state.deviceSellers[raffle.id] : undefined;
  const deviceSeller = raffle?.sellers.find((seller) => seller.id === deviceSellerId);
  const stats = useMemo(() => raffle ? raffleStats(raffle) : null, [raffle]);

  function commit(next: DemoState) {
    setState(next);
  }

  function mutateActive(action: (active: Raffle, next: DemoState) => void) {
    if (!state.activeRaffle) return;
    const next = clone(state);
    try {
      action(next.activeRaffle!, next);
      commit(next);
      setFormError("");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Something went wrong.");
    }
  }

  function goHome() {
    setScreen("home");
    setFormError("");
    setPin("");
  }

  if (!hydrated) {
    return <main className="app-shell loading-shell"><div className="brand-loading">LIONS RAFFLE</div><p>Preparing the raffle…</p></main>;
  }

  function renderHome() {
    return (
      <>
        <Header eyebrow={CLUB_NAME} title="Raffle night" />
        <main className="page home-page">
          {raffle ? (
            <>
              <section className="active-card">
                <div className="active-card-top"><StatusPill status={raffle.status} /><span>{formatDateTime(raffle.createdAt)}</span></div>
                <h2>{raffle.name}</h2>
                <div className="active-total"><strong>{stats?.totalTickets.toLocaleString()}</strong><span>valid tickets sold</span></div>
              </section>
              <section className="action-stack" aria-label="Raffle actions">
                <button className="path-card seller-path" onClick={() => deviceSeller ? setScreen("seller") : setScreen("join")}>
                  <span className="path-icon"><Ticket size={25} /></span>
                  <span><strong>{deviceSeller ? `Continue as ${deviceSeller.name}` : "Join raffle"}</strong><small>Sell ticket bundles</small></span>
                  <ChevronRight size={22} />
                </button>
                <button className="path-card admin-path" onClick={() => setScreen("admin-pin")}>
                  <span className="path-icon"><Trophy size={25} /></span>
                  <span><strong>Admin / Draw</strong><small>Stats, settings and prizes</small></span>
                  <ChevronRight size={22} />
                </button>
              </section>
            </>
          ) : (
            <section className="empty-hero">
              <div className="ticket-illustration"><Ticket size={38} /></div>
              <span>No active raffle</span>
              <h2>Ready for the next raffle?</h2>
              <p>Create the raffle, set the bundles and share the four-digit PIN with sellers.</p>
              <Button onClick={() => setScreen("create")}>Create raffle</Button>
            </section>
          )}
          <button className="history-link" onClick={() => setScreen("history")}>
            <span><History size={20} /> Raffle history</span>
            <span>{state.history.length}<ChevronRight size={19} /></span>
          </button>
          <p className="demo-note"><span /> Single-device demo · Supabase-ready</p>
        </main>
      </>
    );
  }

  function renderCreate(editing = false) {
    const initial: RaffleDraft = editing && raffle ? {
      name: raffle.name,
      pin: raffle.pin,
      startingTicket: raffle.startingTicket,
      prizeCount: raffle.prizeCount,
      bundles: raffle.bundles.map(({ quantity, price }) => ({ quantity, price })),
    } : defaultDraft;
    return (
      <>
        <Header eyebrow={editing ? "Admin" : "New raffle"} title={editing ? "Edit settings" : "Set up raffle"} onBack={() => editing ? setScreen("admin") : goHome()} />
        <main className="page form-page">
          <RaffleForm
            key={editing ? raffle?.id : "new"}
            initial={initial}
            submitLabel={editing ? "Save settings" : "Create raffle"}
            onCancel={() => editing ? setScreen("admin") : goHome()}
            onSubmit={(draft) => {
              if (!editing) {
                const next = clone(state);
                next.activeRaffle = createRaffle(draft);
                commit(next);
                setToast("Raffle created.");
                goHome();
                return;
              }
              mutateActive((active) => {
                if (active.settingsLocked) throw new Error("Settings locked after the first completed sale.");
                active.name = draft.name.trim();
                active.pin = draft.pin;
                active.startingTicket = draft.startingTicket;
                active.highestIssued = draft.startingTicket - 1;
                active.prizeCount = draft.prizeCount;
                active.bundles = draft.bundles.map((bundle, index) => ({ id: `bundle_${index + 1}`, ...bundle }));
              });
              setToast("Settings saved.");
              setScreen("admin");
            }}
          />
        </main>
      </>
    );
  }

  function renderJoin(admin = false) {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      if (!raffle) return;
      if (pin !== raffle.pin) {
        setFormError("That PIN does not match the active raffle.");
        return;
      }
      if (admin) {
        setPin("");
        setFormError("");
        setScreen("admin");
        return;
      }
      const cleanedName = sellerName.trim();
      if (!cleanedName) {
        setFormError("Enter your name.");
        return;
      }
      if (raffle.sellers.some((seller) => seller.name.localeCompare(cleanedName, undefined, { sensitivity: "accent" }) === 0)) {
        setFormError("That seller name is already being used in this raffle.");
        return;
      }
      const next = clone(state);
      const seller = { id: `seller_${crypto.randomUUID()}`, name: cleanedName, joinedAt: new Date().toISOString() };
      next.activeRaffle!.sellers.push(seller);
      next.deviceSellers[raffle.id] = seller.id;
      commit(next);
      setPin("");
      setSellerName("");
      setFormError("");
      setScreen("seller");
    };
    return (
      <>
        <Header eyebrow={raffle?.name} title={admin ? "Admin access" : "Join raffle"} onBack={goHome} />
        <main className="page access-page">
          <div className="access-icon">{admin ? <LockKeyhole size={30} /> : <Users size={30} />}</div>
          <h2>{admin ? "Enter the raffle PIN" : "Who is selling?"}</h2>
          <p>{admin ? "Use the same four-digit PIN shared with sellers." : "This phone will remember you for this raffle."}</p>
          <form onSubmit={submit} className="form-stack access-form">
            {formError && <Notice tone="warning">{formError}</Notice>}
            {!admin && <label className="field"><span>Seller name</span><input autoFocus value={sellerName} onChange={(event) => setSellerName(event.target.value)} autoComplete="name" placeholder="e.g. Gabe" /></label>}
            <label className="field"><span>4-digit PIN</span><input autoFocus={admin} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" autoComplete="one-time-code" placeholder="••••" /></label>
            <Button type="submit">{admin ? "Open admin" : "Join and sell"}</Button>
          </form>
        </main>
      </>
    );
  }

  function renderSeller() {
    if (!raffle || !deviceSeller || !stats) return renderHome();
    const lastSale = latestCompletedSaleForSeller(raffle, deviceSeller.id);
    const ownActive = raffle.reservations.find((reservation) => reservation.sellerId === deviceSeller.id && reservation.status === "active");
    return (
      <>
        <Header eyebrow={raffle.name} title={`Hi, ${deviceSeller.name}`} onBack={goHome} action={<StatusPill status={raffle.status} />} />
        <main className="page seller-page">
          <section className="seller-total">
            <span>Tickets sold</span>
            <strong>{stats.totalTickets.toLocaleString()}</strong>
            <small>Valid tickets in this raffle</small>
          </section>
          {raffle.status !== "selling" && <Notice tone="warning"><strong>Sales are paused.</strong> The raffle is currently in Draw mode.</Notice>}
          {ownActive && (
            <button className="resume-card" onClick={() => { setSelectedReservationId(ownActive.id); setScreen("ticket"); }}>
              <span><Clock3 size={21} /><strong>Unprinted reservation</strong></span>
              <span>Open ticket <ChevronRight size={18} /></span>
            </button>
          )}
          <section className="bundle-section">
            <div className="section-heading"><div><span>Quick sale</span><h2>Choose a bundle</h2></div><Ticket size={24} /></div>
            <div className="bundle-grid">
              {raffle.bundles.map((bundle, index) => (
                <button key={bundle.id} disabled={raffle.status !== "selling" || Boolean(ownActive)} className={`bundle-button bundle-${index + 1}`} onClick={() => { setSelectedBundleId(bundle.id); setScreen("confirm-sale"); }}>
                  <strong>{bundle.quantity}</strong>
                  <span>tickets</span>
                  <small>{formatMoney(bundle.price)}</small>
                </button>
              ))}
            </div>
          </section>
          {lastSale && (
            <section className="panel last-sale">
              <div className="section-heading compact"><div><span>Your latest sale</span><h3>{formatRanges(lastSale.ticketNumbers)}</h3></div><Check size={21} /></div>
              <div className="last-sale-meta"><span>{lastSale.quantity} tickets</span><span>{formatMoney(lastSale.amount)}</span><span>{formatDateTime(lastSale.completedAt)}</span></div>
              <div className="button-row">
                <Button variant="secondary" onClick={() => { setSelectedReservationId(lastSale.id); setScreen("ticket"); }}><Printer size={18} /> Reprint</Button>
                <Button variant="ghost" disabled={raffle.status !== "selling"} onClick={() => setConfirm({
                  title: "Void latest sale?",
                  body: `Tickets ${formatRanges(lastSale.ticketNumbers)} will stop counting as sold and become available again.`,
                  label: "Void sale",
                  destructive: true,
                  action: () => mutateActive((active) => voidLatestSale(active, deviceSeller.id, lastSale.id)),
                })}><Trash2 size={18} /> Void sale</Button>
              </div>
            </section>
          )}
        </main>
      </>
    );
  }

  function renderSaleConfirmation() {
    if (!raffle || !deviceSeller) return renderHome();
    const bundle = raffle.bundles.find((item) => item.id === selectedBundleId);
    if (!bundle) return renderSeller();
    return (
      <>
        <Header eyebrow={raffle.name} title="Confirm sale" onBack={() => setScreen("seller")} />
        <main className="page confirmation-page">
          <section className="confirm-ticket">
            <div className="confirm-ticket-icon"><Ticket size={34} /></div>
            <span>Ticket bundle</span>
            <strong>{bundle.quantity}</strong>
            <h2>tickets</h2>
            <div className="price-line">{formatMoney(bundle.price)}</div>
          </section>
          <Notice>Ticket numbers are reserved only when you press Confirm. The reservation then lasts two minutes while you print.</Notice>
          <div className="sticky-actions">
            <Button variant="secondary" onClick={() => setScreen("seller")}>Cancel</Button>
            <Button onClick={() => mutateActive((active) => {
              const reservation = reserveBundle(active, deviceSeller.id, bundle.id);
              setSelectedReservationId(reservation.id);
              setScreen("ticket");
            })}>Confirm sale</Button>
          </div>
        </main>
      </>
    );
  }

  function renderTicket() {
    if (!raffle) return renderHome();
    const reservation = raffle.reservations.find((item) => item.id === selectedReservationId);
    if (!reservation) return renderSeller();
    const isActive = reservation.status === "active";
    const isCompleted = reservation.status === "completed";
    const seconds = Math.max(0, Math.ceil((new Date(reservation.expiresAt).getTime() - now) / 1000));
    const ticketTime = reservation.completedAt ?? reservation.createdAt;
    return (
      <>
        <Header eyebrow={isCompleted ? "Sale complete" : "Reserved"} title="Customer ticket" onBack={isCompleted ? () => setScreen("seller") : undefined} action={isActive ? <span className="countdown"><Clock3 size={15} /> {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span> : undefined} />
        <main className="page ticket-page">
          {!isActive && !isCompleted && <Notice tone="warning">This unprinted reservation expired. Its ticket numbers are available for another sale.</Notice>}
          <article className="paper-ticket">
            <div className="ticket-top">
              <span>{CLUB_NAME}</span>
              <h2>{raffle.name}</h2>
              <time>{formatDateTime(ticketTime)}</time>
            </div>
            <div className="ticket-range">
              <span>Your tickets</span>
              <strong>{formatRanges(reservation.ticketNumbers)}</strong>
            </div>
            <div className="ticket-numbers" aria-label="Individual ticket numbers">
              {reservation.ticketNumbers.map((ticketNumber) => <span key={ticketNumber}>{ticketNumber}</span>)}
            </div>
            <div className="ticket-purchase">
              <div><strong>{reservation.quantity}</strong><span>tickets</span></div>
              <div><strong>{formatMoney(reservation.amount)}</strong><span>paid</span></div>
            </div>
            <p>Thanks for your support!</p>
          </article>
          {isActive && <Notice tone="warning"><strong>Not sold yet.</strong> Printing completes and locks this sale.</Notice>}
          {isCompleted && <Notice tone="success"><Check size={18} /> Printed successfully · sale locked</Notice>}
          <div className="ticket-actions">
            {isActive && <Button variant="secondary" onClick={() => mutateActive((active) => { cancelReservation(active, reservation.id); setScreen("seller"); })}><X size={18} /> Cancel</Button>}
            {(isActive || isCompleted) && <Button onClick={() => mutateActive((active) => {
              const sale = completePrint(active, reservation.id);
              setToast(isCompleted ? `Reprint ${sale.printCount} simulated.` : "Print simulated — sale completed.");
            })}><Printer size={19} /> {isCompleted ? "Reprint" : "Print"}</Button>}
            {!isActive && !isCompleted && <Button onClick={() => setScreen("seller")}>Back to selling</Button>}
          </div>
          {isCompleted && <Button className="done-button" variant="secondary" onClick={() => setScreen("seller")}>Done</Button>}
        </main>
      </>
    );
  }

  function renderAdmin() {
    if (!raffle || !stats) return renderHome();
    const pending = raffle.reservations.filter((reservation) => reservation.status === "active" && new Date(reservation.expiresAt).getTime() > now);
    const candidate = currentCandidate(raffle);
    const nextPrize = nextUnfilledPrize(raffle);
    const allPrizesFilled = raffle.winners.length === raffle.prizeCount;
    return (
      <>
        <Header eyebrow={raffle.name} title="Admin" onBack={goHome} action={<StatusPill status={raffle.status} />} />
        <main className="page admin-page">
          <section className="stat-grid admin-stats">
            <div className="stat-feature"><span>Valid tickets sold</span><strong>{stats.totalTickets.toLocaleString()}</strong></div>
            <div className="stat-feature"><span>Expected sales</span><strong>{formatMoney(stats.expectedRevenue)}</strong></div>
            <div><span>First ticket</span><strong>{raffle.startingTicket.toLocaleString()}</strong></div>
            <div><span>Highest issued</span><strong>{raffle.highestIssued >= raffle.startingTicket ? raffle.highestIssued.toLocaleString() : "—"}</strong></div>
          </section>

          {stats.missingNumbers.length > 0 && (
            <Notice tone="warning">
              <div className="notice-title"><TriangleAlert size={19} /><strong>External draw range is unsafe</strong></div>
              <p>Missing: {stats.missingRanges}. The built-in draw uses only valid sold tickets and remains safe.</p>
            </Notice>
          )}

          {raffle.status === "selling" ? (
            <section className="draw-cta">
              <div><span>When selling is finished</span><h2>Start the draw</h2><p>Sales and voids pause until you return to Selling.</p></div>
              {pending.length > 0 && <Notice tone="warning">{pending.length} unprinted {pending.length === 1 ? "reservation is" : "reservations are"} still active.</Notice>}
              <Button disabled={pending.length > 0 || stats.totalTickets === 0} onClick={() => mutateActive((active) => startDraw(active))}><Trophy size={20} /> Start Draw</Button>
            </section>
          ) : (
            <section className="draw-stage">
              <div className="draw-stage-head">
                <div><span>Drawing now</span><h2>{candidate ? `Prize ${candidate.prizeNumber}` : nextPrize ? `Prize ${nextPrize}` : "All prizes filled"}</h2></div>
                <Button variant="ghost" disabled={Boolean(candidate)} onClick={() => mutateActive((active) => returnToSelling(active))}>Return to Selling</Button>
              </div>
              {candidate ? (
                <div className="candidate-card">
                  <span>Candidate ticket</span>
                  <strong>{candidate.ticketNumber}</strong>
                  <p>Wait for the ticket holder to claim this prize.</p>
                  <div className="candidate-actions">
                    <Button variant="secondary" onClick={() => mutateActive((active) => redrawCandidate(active))}><RotateCcw size={18} /> Redraw</Button>
                    <Button onClick={() => mutateActive((active) => confirmWinner(active))}><Check size={19} /> Confirm winner</Button>
                  </div>
                </div>
              ) : !allPrizesFilled ? (
                <div className="draw-ready"><Trophy size={35} /><p>Ready to choose from {stats.totalTickets - raffle.drawEvents.length} eligible tickets.</p><Button onClick={() => mutateActive((active) => drawCandidate(active))}>Draw candidate</Button></div>
              ) : (
                <div className="draw-ready complete"><Check size={35} /><h3>Every prize is filled</h3><p>Review the winners, then end the raffle.</p><Button onClick={() => setConfirm({
                  title: "End this raffle?",
                  body: "This is permanent for the MVP. The raffle will become read-only and move to History.",
                  label: "End raffle",
                  destructive: true,
                  action: () => {
                    const next = clone(state);
                    endRaffle(next.activeRaffle!);
                    const finished = next.activeRaffle!;
                    next.history = [finished, ...next.history];
                    next.activeRaffle = null;
                    setSelectedHistoryId(finished.id);
                    commit(next);
                    setScreen("summary");
                  },
                })}>End raffle</Button></div>
              )}
            </section>
          )}

          <section className="panel">
            <div className="section-heading compact"><div><span>Configured prizes</span><h3>{raffle.winners.length} of {raffle.prizeCount} confirmed</h3></div><Trophy size={21} /></div>
            <div className="prize-list">
              {Array.from({ length: raffle.prizeCount }, (_, index) => {
                const prizeNumber = index + 1;
                const winner = raffle.winners.find((item) => item.prizeNumber === prizeNumber);
                return (
                  <div key={prizeNumber} className={winner ? "prize-filled" : ""}>
                    <span>Prize {prizeNumber}</span>
                    <strong>{winner ? `#${winner.ticketNumber}` : "Unfilled"}</strong>
                    {winner && raffle.status === "drawing" && <button aria-label={`Undo Prize ${prizeNumber} winner`} onClick={() => setConfirm({
                      title: `Undo Prize ${prizeNumber} winner?`,
                      body: `Ticket #${winner.ticketNumber} will stay excluded. Prize ${prizeNumber} will need a new draw.`,
                      label: "Undo winner",
                      destructive: true,
                      action: () => mutateActive((active) => undoWinner(active, winner.id)),
                    })}><RotateCcw size={17} /></button>}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <div className="section-heading compact"><div><span>Sales mix</span><h3>Bundle breakdown</h3></div><Banknote size={21} /></div>
            <div className="breakdown-list">
              {stats.bundleBreakdown.map((bundle) => <div key={bundle.id}><div><strong>{bundle.quantity} for {formatMoney(bundle.price)}</strong><span>{bundle.sales} {bundle.sales === 1 ? "sale" : "sales"} · {bundle.tickets} tickets</span></div><strong>{formatMoney(bundle.revenue)}</strong></div>)}
            </div>
          </section>

          {!raffle.settingsLocked && raffle.status === "selling" && <Button className="wide-button" variant="secondary" onClick={() => setScreen("edit")}><Pencil size={18} /> Edit raffle settings</Button>}
          {raffle.settingsLocked && <p className="locked-note"><LockKeyhole size={15} /> Settings locked after the first completed sale</p>}
        </main>
      </>
    );
  }

  function renderHistory() {
    return (
      <>
        <Header eyebrow="Completed raffles" title="Raffle history" onBack={goHome} />
        <main className="page history-page">
          {state.history.length === 0 ? (
            <section className="empty-history"><History size={38} /><h2>No completed raffles yet</h2><p>Ended raffles and their winners will appear here.</p></section>
          ) : (
            <div className="history-list">
              {[...state.history].sort((a, b) => new Date(b.endedAt ?? 0).getTime() - new Date(a.endedAt ?? 0).getTime()).map((item) => {
                const itemStats = raffleStats(item);
                return (
                  <article className="history-card" key={item.id}>
                    <button className="history-main" onClick={() => { setSelectedHistoryId(item.id); setScreen("summary"); }}>
                      <span>{formatDateTime(item.endedAt)}</span>
                      <strong>{item.name}</strong>
                      <small>{itemStats.totalTickets} tickets · {formatMoney(itemStats.expectedRevenue)} · {item.prizeCount} {item.prizeCount === 1 ? "prize" : "prizes"}</small>
                    </button>
                    <button className="history-delete" aria-label={`Delete ${item.name}`} onClick={() => setConfirm({
                      title: "Delete this raffle permanently?",
                      body: `${item.name} and its summary will be removed from History.`,
                      label: "Delete raffle",
                      destructive: true,
                      action: () => {
                        const next = clone(state);
                        next.history = next.history.filter((raffleItem) => raffleItem.id !== item.id);
                        commit(next);
                      },
                    })}><Trash2 size={19} /></button>
                  </article>
                );
              })}
            </div>
          )}
        </main>
      </>
    );
  }

  function renderSummary() {
    const selected = state.history.find((item) => item.id === selectedHistoryId);
    if (!selected) return renderHistory();
    return (
      <>
        <Header eyebrow="Raffle history" title="Final summary" onBack={() => setScreen("history")} />
        <main className="page summary-page"><Summary raffle={selected} /></main>
      </>
    );
  }

  let content: ReactNode;
  switch (screen) {
    case "create": content = renderCreate(); break;
    case "edit": content = renderCreate(true); break;
    case "join": content = renderJoin(); break;
    case "admin-pin": content = renderJoin(true); break;
    case "seller": content = renderSeller(); break;
    case "confirm-sale": content = renderSaleConfirmation(); break;
    case "ticket": content = renderTicket(); break;
    case "admin": content = renderAdmin(); break;
    case "history": content = renderHistory(); break;
    case "summary": content = renderSummary(); break;
    default: content = renderHome();
  }

  return (
    <div className="app-shell">
      {content}
      {toast && <div className="toast" role="status">{toast}</div>}
      <ConfirmDialog value={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
