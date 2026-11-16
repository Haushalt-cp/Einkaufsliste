// Holt die Wochenaktionen von Denner (denner.ch + aktionis.ch) und Migros (migros.ch, Region Aare; Notfall aktionis.ch)
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
const ent = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

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
// Denner: zuerst die eigene Seite (zeigt die kommende Woche früh), ergänzt durch aktionis.ch (vollständige Liste)
async function denner(): Promise<Angebot[]> {
  let direkt: Angebot[] = [];
  try { direkt = dennerSeite(await holen("https://www.denner.ch/de/aktionen/aktionen-ab-donnerstag")); }
  catch (e) { console.error("Denner direkt", e); }
  let weitere: Angebot[] = [];
  try { weitere = await aktionis("denner", /denner/i); } catch (e) { console.error("Denner aktionis", e); if (!direkt.length) throw e; }
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
  // 1. Alle Aktions-Produkt-IDs der Region (laufend und kommend)
  const ids = new Set<number>();
  for (const kommend of [false, true]) {
    for (let von = 0, total = 1; von < total && von < 4000; von += 100) {
      const url = "https://www.migros.ch/product-display/public/web/v1/products/promotion/search" + (kommend ? "?forceUpcomingPromotions=true" : "");
      const r = await post(url, { regionId: MIGROS_REGION, language: "de", from: von, limit: 100, sortFields: [], sortOrder: "asc", filters: {} });
      total = Number(r.numberOfProducts) || 0;
      for (const id of r.productIds || []) ids.add(Number(id));
      if (!(r.productIds || []).length) break;
    }
  }
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

/* ---------- Speichern ---------- */
async function abrufen(laden: "Denner" | "Migros", quelle: string, fn: () => Promise<Angebot[]>) {
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
    abrufen("Denner", "denner.ch + aktionis.ch", denner),
    abrufen("Migros", "migros.ch Region Aare", migros),
  ]);
  // Alte Abrufe (älter als 3 Wochen) aufräumen
  const grenze = new Date(Date.now() - 21 * 864e5).toISOString();
  await db.from("aktion_abruf").delete().lt("gestartet_am", grenze);
  return antwort({ ergebnis });
});
