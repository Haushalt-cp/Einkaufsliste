// Holt die Wochenaktionen von Denner (denner.ch; Notfall aktionis.ch), Migros (migros.ch, Region Aare; Notfall aktionis.ch) und Lidl (lidl.ch)
// und speichert sie in aktion_abruf / aktion_angebot.
// Aufruf: zeitgesteuert (Header x-abruf-token) oder von einem Admin der App (Login-Token).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(URL_, SERVICE, { auth: { persistSession: false } });

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-abruf-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const antwort = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Angebot = {
  quelle_id: string; name: string; beschreibung?: string | null; preis?: number | null; preis_alt?: number | null;
  rabatt?: string | null; bild_url?: string | null; kategorie?: string | null; gueltig_von?: string | null; gueltig_bis?: string | null;
  marke?: string | null;   // Migros: Marke, damit die App Aktionen einer Marke bündeln kann
};

async function holen(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "de-CH,de;q=0.9", "Accept": "text/html" } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return await r.text();
}
const zahl = (s: unknown) => {
  if (s === null || s === undefined) return null;
  const m = String(s).replace(/[–-]\./, "0.").replace(/[^\d.,]/g, "").replace(",", ".");
  const n = parseFloat(m);
  return Number.isFinite(n) ? n : null;
};
const datum = (unix: unknown) => {
  const n = Number(unix);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
};
const ENT: Record<string, string> = { amp: "&", quot: '"', lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", reg: "®", trade: "™", deg: "°", frac12: "½", euro: "€" };
const ent = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&([a-zA-Z0-9]+);/g, (m, n) => ENT[n] ?? m).replace(/\s+/g, " ").trim();

/* ---------- Denner: Nuxt-Daten (devalue-Format) ---------- */
function nuxtDaten(html: string): unknown[] {
  const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("Denner: keine Seitendaten gefunden");
  return JSON.parse(m[1]);
}
function aufloesen(arr: unknown[], i: number, tiefe = 0): unknown {
  if (tiefe > 40 || typeof i !== "number" || i < 0) return null;
  const v = arr[i];
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    if (typeof v[0] === "string" && ["Reactive", "ShallowReactive", "Ref", "ShallowRef", "EmptyRef", "EmptyShallowRef"].includes(v[0] as string))
      return aufloesen(arr, v[1] as number, tiefe + 1);
    return v.map((x) => aufloesen(arr, x as number, tiefe + 1));
  }
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) o[k] = aufloesen(arr, x as number, tiefe + 1);
  return o;
}
function dennerSeite(html: string): Angebot[] {
  const arr = nuxtDaten(html);
  const angebote: Angebot[] = [];
  arr.forEach((v, i) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return;
    const o = v as Record<string, unknown>;
    if ("sku" in o && "attributeInfo" in o) {
      const it = aufloesen(arr, i) as Record<string, unknown>;
      const a: Record<string, string> = {};
      for (const att of (it.attributeInfo as Array<Record<string, unknown>>) || []) {
        const vals = (att.vals as Array<Record<string, unknown>>) || [];
        a[String(att.attributeName)] = vals.length ? String(vals[0]?.value ?? "") : "";
      }
      if (!a.name) return;
      angebote.push({
        quelle_id: a.articleId || String(it.sku),
        name: a.name.trim(),
        beschreibung: a.nameSubline || null,
        preis: zahl(a.price),
        preis_alt: zahl(a.insteadPriceText),
        rabatt: a.discount_text || null,
        bild_url: a.thumbnailUrl || a.imageUrl || null,
        kategorie: a._tracking_item_category2 || null,
        gueltig_von: datum(a.promotionFrom),
        gueltig_bis: datum(a.promotionTo),
      });
    }
  });
  return angebote;
}
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
// Denner: Schnittstelle der eigenen Webseite (alle Seiten, aktuelle und kommende Woche); Notfall: aktionis.ch
function dennerAttr(it: Record<string, any>): Record<string, string> {
  const a: Record<string, string> = {};
  for (const att of it.attributeInfo || []) a[String(att.attributeName)] = att.vals?.length ? String(att.vals[0]?.value ?? "") : "";
  return a;
}
function dennerAngebot(it: Record<string, any>): Angebot | null {
  const a = dennerAttr(it);
  if (!a.name) return null;
  // Publikationswoche "19.11.–25.11.2026" = Aktionswoche; einzelne Artikel gelten nur an Teilen davon (promotionLabel)
  const pub = a.promotionLabelPublication?.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})?\s*[–-]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  const iso = (d: string, m: string, y: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const von = pub ? iso(pub[1], pub[2], pub[3] || pub[6]) : tagCH(a.promotionFrom);
  const echtVon = tagCH(a.promotionFrom), echtBis = tagCH(a.promotionTo);
  const teil = echtVon && von && echtVon > von && a.promotionLabel ? `nur ${a.promotionLabel}` : "";
  return {
    quelle_id: `${a.articleId || it.sku}-${von || ""}`,
    name: a.name.trim(),
    beschreibung: [a.nameSubline, teil].filter(Boolean).join(" · ") || null,
    preis: zahl(a.price),
    preis_alt: zahl(a.insteadPriceText),
    rabatt: a.discount_text || null,
    bild_url: a.thumbnailUrl || a.imageUrl || null,
    kategorie: a._tracking_item_category2 || null,
    gueltig_von: von,
    gueltig_bis: echtBis || (pub ? iso(pub[4], pub[5], pub[6]) : null),
  };
}
async function dennerApi(): Promise<Angebot[]> {
  const alle: Angebot[] = [];
  for (const flag of ["promo_next_week", "promo_current_week"]) {
    for (let seite = 1, seiten = 1; seite <= seiten && seite <= 15; seite++) {
      const r = await fetch("https://www.denner.ch/nuxt-api/promotions", {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json", "Origin": "https://www.denner.ch", "Referer": "https://www.denner.ch/de/aktionen/aktionen-ab-donnerstag" },
        body: JSON.stringify({ lang: "de", promoFlag: flag, facetName: null, facetValue: null, page: seite, hitsPerPage: 100, sort: null, includeHighlights: seite === 1 }),
      });
      if (!r.ok) throw new Error(`Denner ${flag}: HTTP ${r.status}`);
      const j = await r.json();
      seiten = Number(j?.stats?.totalPages) || 1;
      const items = [...(j.items || []), ...((j.highlights || []).flatMap((h: Record<string, any>) => h.items || []))];
      for (const it of items) { const x = dennerAngebot(it); if (x) alle.push(x); }
    }
  }
  return alle;
}
async function denner(): Promise<Angebot[]> {
  try {
    const a = await dennerApi();
    if (a.length) return a;
  } catch (e) { console.error("Denner API", e); }
  // Notfall: eigene Seite (nur erste Artikel) + aktionis.ch
  let direkt: Angebot[] = [];
  try { direkt = dennerSeite(await holen("https://www.denner.ch/de/aktionen/aktionen-ab-donnerstag")); } catch (e) { console.error("Denner Seite", e); }
  let weitere: Angebot[] = [];
  try { weitere = await aktionis("denner", /denner/i); } catch (e) { if (!direkt.length) throw e; }
  const namen = new Set(direkt.map((a) => norm(a.name)));
  return [...direkt, ...weitere.filter((a) => !namen.has(norm(a.name))).map((a) => ({ ...a, quelle_id: "ak" + a.quelle_id }))];
}

/* ---------- Migros: aktionis.ch ---------- */
function aktionisSeite(html: string, haendlerMuster: RegExp): Angebot[] {
  const angebote: Angebot[] = [];
  const teile = html.split(/<div data-upox-id="/).slice(1);
  for (const t of teile) {
    const id = t.match(/^(\d+)"/)?.[1];
    if (!id) continue;
    const haendler = t.match(/class="card-merchant">\s*<img[^>]*alt="([^"]*)"/)?.[1];
    if (haendler && !haendlerMuster.test(haendler)) continue;
    const name = t.match(/<h3 class="card-title[^"]*">([\s\S]*?)<\/h3>/)?.[1];
    if (!name) continue;
    const beschr = t.match(/<p class="card-description[^"]*">([\s\S]*?)<\/p>/)?.[1] || "";
    const bis = beschr.match(/bis (?:zum |am )?(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    const von = beschr.match(/vom (\d{1,2})\.(\d{1,2})\.(?:(\d{4}))?/);
    const iso = (d: string, m: string, y: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    angebote.push({
      quelle_id: id,
      name: ent(name),
      beschreibung: ent(beschr) || null,
      preis: zahl(t.match(/class="price-new">([^<]*)</)?.[1]),
      preis_alt: zahl(t.match(/class="price-old">([^<]*)</)?.[1]),
      rabatt: ent(t.match(/class="price-discount"[^>]*>([^<]*)</)?.[1] || "") || null,
      bild_url: t.match(/class="card-image">\s*<img src="([^"]+)"/)?.[1] || null,
      kategorie: null,
      gueltig_bis: bis ? iso(bis[1], bis[2], bis[3]) : null,
      gueltig_von: von && bis ? iso(von[1], von[2], von[3] || bis[3]) : null,
    });
  }
  return angebote;
}
async function aktionis(haendler: string, muster: RegExp): Promise<Angebot[]> {
  const basis = `https://www.aktionis.ch/vendors/${haendler}`;
  const gesehen = new Set<string>();
  const alle: Angebot[] = [];
  for (let p = 1; p <= 40; p++) {
    let neu = 0;
    try {
      for (const a of aktionisSeite(await holen(p === 1 ? basis : `${basis}?page=${p}`), muster)) {
        if (gesehen.has(a.quelle_id)) continue;
        gesehen.add(a.quelle_id); alle.push(a); neu++;
      }
    } catch (e) { if (p === 1) throw e; break; }
    if (!neu) break;
  }
  return alle;
}

/* ---------- Migros direkt (Genossenschaft Aare, Code gmaa) ---------- */
const MIGROS_REGION = "gmaa";
// Naechster Einkaufstag (Donnerstag, Schweizer Zeit); heute, falls heute Donnerstag
function einkaufstag(): string {
  const jetzt = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
  const diff = (4 - jetzt.getDay() + 7) % 7;
  jetzt.setDate(jetzt.getDate() + diff);
  return `${jetzt.getFullYear()}-${String(jetzt.getMonth() + 1).padStart(2, "0")}-${String(jetzt.getDate()).padStart(2, "0")}`;
}
async function migrosDirekt(): Promise<Angebot[]> {
  const kopf: Record<string, string> = {
    "User-Agent": UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "de-CH,de;q=0.9",
    "Referer": "https://www.migros.ch/de/offers/home", "Origin": "https://www.migros.ch",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124"', "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
    "migros-language": "de", "peer-id": "website-js-800.0.0",
  };
  const g = await fetch("https://www.migros.ch/authentication/public/v1/api/guest?authorizationNotRequired=true", { headers: kopf });
  const tok = g.headers.get("leshopch");
  if (!g.ok || !tok) throw new Error(`Migros Gast-Zugang: HTTP ${g.status}`);
  const h = { ...kopf, "Content-Type": "application/json", leshopch: tok };
  const post = async (url: string, body: unknown) => {
    const r = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return await r.json();
  };
  // 1. Alle Aktions-Produkt-IDs der Region: laufende und kommende Woche (Schnittstelle v2, period CURRENT/UPCOMING).
  //    Die alte v1-Abfrage mit forceUpcomingPromotions liefert die kommende Woche nicht mehr.
  const ids = new Set<number>();
  for (const period of ["CURRENT", "UPCOMING"]) {
    try {
      for (let von = 0; von < 4000; von += 100) {
        const r = await post("https://www.migros.ch/product-display/public/web/v2/products/promotion/search",
          { storeType: "OFFLINE", period, language: "de", filters: {}, sortFields: [], sortOrder: "asc", from: von, until: von + 100, region: MIGROS_REGION, warehouse: "1" });
        const items = r.items || [];
        for (const it of items) if (it?.id != null && (!it.type || it.type === "PRODUCT")) ids.add(Number(it.id));
        if (!items.length || von + 100 >= (Number(r.numberOfItems) || 0)) break;
      }
    } catch (e) { console.error("Migros v2", period, e); }
  }
  // Zusätzlich (und als Rückfall) die bisherige v1-Abfrage
  for (const kommend of [false, true]) {
    try {
      for (let von = 0, total = 1; von < total && von < 4000; von += 100) {
        const url = "https://www.migros.ch/product-display/public/web/v1/products/promotion/search" + (kommend ? "?forceUpcomingPromotions=true" : "");
        const r = await post(url, { regionId: MIGROS_REGION, language: "de", from: von, limit: 100, sortFields: [], sortOrder: "asc", filters: {} });
        total = Number(r.numberOfProducts) || 0;
        for (const id of r.productIds || []) ids.add(Number(id));
        if (!(r.productIds || []).length) break;
      }
    } catch (e) { console.error("Migros v1", e); }
  }
  if (!ids.size) throw new Error("Migros: keine Aktions-Produkte gefunden");
  // 2. Produktdetails mit dem Angebot, das am Einkaufstag gilt; sonst das aktuelle
  const tag = einkaufstag();
  const karten = async (liste: number[], datum?: string) => {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < liste.length; i += 200) {
      const filter: Record<string, string> = { storeType: "OFFLINE", region: MIGROS_REGION };
      if (datum) filter.ongoingOfferDate = `${datum}T00:00:00`;
      out.push(...await post("https://www.migros.ch/product-display/public/v4/product-cards", { offerFilter: filter, productFilter: { uids: liste.slice(i, i + 200) } }));
    }
    return out;
  };
  const alle = [...ids];
  const amTag = await karten(alle, tag);
  const mitAktion = (k: Record<string, any>) => k?.offer?.promotionPrice && k?.offer?.promotionDateRange;
  const ohne = amTag.filter((k) => !mitAktion(k)).map((k) => Number(k.uid));
  const aktuell = ohne.length ? await karten(ohne) : [];
  const angebote: Angebot[] = [];
  for (const k of [...amTag, ...aktuell] as Record<string, any>[]) {
    if (!mitAktion(k)) continue;
    const o = k.offer;
    const titel = String(k.title || [k.brand, k.name, k.versioning].filter(Boolean).join(" · "));
    const badge = (o.badges || []).map((b: Record<string, string>) => b.description).filter(Boolean).join(" · ");
    angebote.push({
      quelle_id: String(k.uid),
      name: titel.replace(/\s*·\s*/g, " · "),
      beschreibung: [o.quantity, o.quantityPrice].filter(Boolean).join(", ") || null,
      preis: Number(o.promotionPrice.effectiveValue) || null,
      preis_alt: Number(o.price?.effectiveValue) || null,
      rabatt: badge || null,
      bild_url: (k.images?.[0]?.url || "").replace("{stack}", "small") || null,
      kategorie: k.breadcrumb?.[0]?.name || null,
      gueltig_von: o.promotionDateRange.startDate || null,
      gueltig_bis: o.promotionDateRange.endDate || null,
      marke: k.brand ? String(k.brand).trim() : null,
    });
  }
  return angebote;
}
async function migros(): Promise<Angebot[]> {
  try {
    const a = await migrosDirekt();
    if (a.length) return a;
  } catch (e) { console.error("Migros direkt", e); }
  return await aktionis("migros", /migros/i);   // Notfall: aktionis.ch (nicht regional)
}

/* ---------- Lidl: Wochenaktion-Seiten auf lidl.ch ---------- */
const tagCH = (unix: unknown) => {
  const n = Number(unix);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date(n * 1000));
};
const ohneHtml = (s: string) => {
  const teile = [...String(s || "").matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => ent(m[1].replace(/<[^>]+>/g, " "))).filter(Boolean);
  const text = teile.length ? teile.slice(0, 3).join(", ") : ent(String(s || "").replace(/<[^>]+>/g, " "));
  return text.length > 90 ? text.slice(0, 88).replace(/[ ,]+[^ ,]*$/, "") + " …" : text;
};
async function lidl(): Promise<Angebot[]> {
  const start = await holen("https://www.lidl.ch/");
  // Lebensmittel-Aktionsseiten: Wochenaktion, Super-Wochenende, Neu im Sortiment, Deluxe, Favorina, Lidl Plus
  const LIDL_SEITEN = /^\/c\/de-CH\/store\/(wochenaktion|super-wochenende|neu-in-unserem-sortiment|deluxe|favorina|lidl-plus-angebote|frische[a-z\-]*|wochenende[a-z\-]*)\/a\d+$/;
  const seiten = [...new Set([...start.matchAll(/href="(\/c\/de-CH\/store\/[a-z0-9\-]+\/a\d+)"/g)].map((m) => m[1]).filter((p) => LIDL_SEITEN.test(p)))];
  if (!seiten.some((p) => p.includes("/wochenaktion/"))) throw new Error("Lidl: keine Wochenaktion-Seiten gefunden");
  const angebote: Angebot[] = [];
  for (const pfad of seiten.slice(0, 14)) {
    let html = "";
    try { html = await holen("https://www.lidl.ch" + pfad); } catch (e) { console.error("Lidl", pfad, e); continue; }
    for (const m of html.matchAll(/data-grid-data="([^"]*)"/g)) {
      let d: Record<string, any>;
      try { d = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#0?39;/g, "'").replace(/&amp;/g, "&")); }
      catch { continue; }
      const titel = d.fullTitle || d.title;
      if (!titel || !d.productId) continue;
      const plus = d.lidlPlus?.[0];
      const preis = d.price?.price ?? plus?.price?.price ?? null;
      const alt = d.price?.oldPrice ?? d.price?.discount?.deletedPrice ?? plus?.price?.oldPrice ?? null;
      let rabatt = d.price?.discount?.discountText || "";
      if (!d.price?.price && plus) rabatt = `Lidl Plus ${plus.highlightText || plus.price?.discount?.discountText || ""}`.trim();
      const kat = String(d.keyfacts?.wonCategoryPrimary || "").split("/");
      angebote.push({
        quelle_id: String(d.productId),
        name: ent(String(titel)),
        beschreibung: ohneHtml(d.keyfacts?.description || "") || null,
        preis: typeof preis === "number" ? preis : zahl(preis),
        preis_alt: (typeof alt === "number" ? alt : zahl(alt)) || null,
        rabatt: rabatt || null,
        bild_url: d.image || null,
        kategorie: kat[3] || kat[2] || d.category || null,
        gueltig_von: tagCH(d.storeStartDate),
        gueltig_bis: tagCH(d.storeEndDate),
      });
    }
  }
  return angebote;
}

/* ---------- Speichern ---------- */
async function abrufen(laden: "Denner" | "Migros" | "Lidl", quelle: string, fn: () => Promise<Angebot[]>) {
  const { data: abruf, error } = await db.from("aktion_abruf").insert({ laden, quelle }).select().single();
  if (error) throw error;
  try {
    const liste = await fn();
    const eindeutig = [...new Map(liste.map((a) => [a.quelle_id, a])).values()];
    for (let i = 0; i < eindeutig.length; i += 200) {
      const { error: e } = await db.from("aktion_angebot").insert(eindeutig.slice(i, i + 200).map((a) => ({ ...a, laden, abruf_id: abruf.id })));
      if (e) throw e;
    }
    await db.from("aktion_abruf").update({ beendet_am: new Date().toISOString(), anzahl: eindeutig.length }).eq("id", abruf.id);
    return { laden, anzahl: eindeutig.length };
  } catch (e) {
    await db.from("aktion_abruf").update({ beendet_am: new Date().toISOString(), fehler: String((e as Error).message || e) }).eq("id", abruf.id);
    return { laden, fehler: String((e as Error).message || e) };
  }
}

async function berechtigt(req: Request): Promise<boolean> {
  const tok = req.headers.get("x-abruf-token");
  if (tok) {
    const { data } = await db.rpc("abruf_token_pruefen", { t: tok });
    if (data === true) return true;
  }
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return false;
  const { data: u } = await db.auth.getUser(jwt);
  if (!u?.user) return false;
  const { data: b } = await db.from("benutzer").select("rolle").eq("id", u.user.id).single();
  return b?.rolle === "admin";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await berechtigt(req))) return antwort({ fehler: "Keine Berechtigung" }, 401);
  const ergebnis = await Promise.all([
    abrufen("Denner", "denner.ch", denner),
    abrufen("Migros", "migros.ch Region Aare", migros),
    abrufen("Lidl", "lidl.ch", lidl),
  ]);
  // Alte Abrufe (älter als 3 Wochen) aufräumen
  const grenze = new Date(Date.now() - 21 * 864e5).toISOString();
  await db.from("aktion_abruf").delete().lt("gestartet_am", grenze);
  return antwort({ ergebnis });
});
