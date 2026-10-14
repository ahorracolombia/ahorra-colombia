// Vercel Serverless Function: proxy controlado para catálogos públicos.
// No requiere API keys. Solo consulta dominios permitidos y endpoints de lectura.
const STORES = {
  exito: { platform: "vtex", origin: "https://www.exito.com" },
  olimpica: { platform: "vtex", origin: "https://www.olimpica.com" },
  jumbo: { platform: "vtex", origin: "https://www.jumbo.com.co" },
  euro: { platform: "vtex", origin: "https://www.eurosupermercados.com.co" },
  vaquita: { platform: "magento", origin: "https://vaquitaexpress.com.co" },
  d1: { platform: "html", origin: "https://www.d1.com.co" }
};
const D1_PATHS = new Set([
  "despensa", "bebidas", "hogar", "aseo-y-limpieza", "lacteos-y-huevos",
  "frutas-y-verduras", "pollo-carne-y-pescado", "cuidado-personal-y-belleza",
  "extraordinarios", "carnes-frias-delikatessen"
]);

function reply(res, status, data, type = "application/json; charset=utf-8") {
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", status === 200 ? "public, s-maxage=60, stale-while-revalidate=120" : "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (typeof data === "string") return res.status(status).send(data);
  return res.status(status).json(data);
}
async function fetchWithTimeout(url, options = {}, ms = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`El comercio respondió HTTP ${r.status}`);
    return r;
  } finally { clearTimeout(timer); }
}
module.exports = async function handler(req, res) {
  if (req.method !== "GET") return reply(res, 405, { error: "Método no permitido" });
  const { store, q = "", format = "json" } = req.query || {};
  const cfg = STORES[String(store || "").toLowerCase()];
  if (!cfg) return reply(res, 400, { error: "Comercio no admitido" });
  const query = String(q).trim().slice(0, 100);

  try {
    if (cfg.platform === "vtex") {
      const from = Math.max(0, Math.min(2500, Number.parseInt(req.query.from || "0", 10) || 0));
      const toRaw = Number.parseInt(req.query.to || String(from + 49), 10) || from + 49;
      const to = Math.min(from + 49, Math.max(from, toRaw));
      const url = new URL("/api/catalog_system/pub/products/search", cfg.origin);
      url.searchParams.set("_from", String(from));
      url.searchParams.set("_to", String(to));
      if (query) url.searchParams.set("ft", query);
      const r = await fetchWithTimeout(url.toString(), { headers: { Accept: "application/json", "User-Agent": "AhorrarColombia/1.0" } });
      const products = await r.json();
      return reply(res, 200, { store, products: Array.isArray(products) ? products : [], fetchedAt: new Date().toISOString(), cacheSeconds: 60 });
    }

    if (cfg.platform === "magento") {
      const page = Math.max(1, Math.min(30, Number.parseInt(req.query.page || "1", 10) || 1));
      const gql = `query($search:String,$page:Int){products(search:$search,pageSize:48,currentPage:$page){total_count page_info{current_page page_size total_pages} items{name sku url_key price_range{minimum_price{final_price{value currency}}}}}}`;
      const r = await fetchWithTimeout(`${cfg.origin}/graphql`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: gql, variables: { search: query, page } })
      });
      const data = await r.json();
      if (data.errors?.length) return reply(res, 502, { error: "La tienda no permitió completar la consulta", details: data.errors.map(e => e.message).slice(0, 2) });
      return reply(res, 200, { ...data, store, fetchedAt: new Date().toISOString(), cacheSeconds: 60 });
    }

    if (cfg.platform === "html") {
      const path = String(req.query.path || "").replace(/^\/+|\/+$/g, "").split("?")[0];
      if (!D1_PATHS.has(path)) return reply(res, 400, { error: "Categoría D1 no admitida" });
      const page = Math.max(1, Math.min(30, Number.parseInt(req.query.page || "1", 10) || 1));
      const url = new URL(`/${path}${page > 1 ? `?page=${page}` : ""}`, cfg.origin);
      const r = await fetchWithTimeout(url.toString(), { headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; AhorrarColombia/1.0)" } });
      const html = await r.text();
      // La interfaz ya contiene el extractor D1; devolver HTML únicamente para categorías permitidas.
      return reply(res, 200, html, "text/html; charset=utf-8");
    }
    return reply(res, 400, { error: "Fuente no soportada" });
  } catch (e) {
    const timedOut = e?.name === "AbortError";
    return reply(res, 502, {
      error: timedOut ? "La tienda tardó demasiado en responder" : "No fue posible consultar el catálogo",
      store, retryable: true, fetchedAt: new Date().toISOString()
    });
  }
};
