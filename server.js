require("dotenv").config();

const express = require("express");
const compression = require("compression");
const cheerio = require("cheerio");
const http = require("http");
const https = require("https");

const app = express();

// ─── Configuration ───────────────────────────────────────────────
const SOURCE_HOST = process.env.SOURCE_HOST || "www.crossingbroad.com";
const SOURCE_ORIGIN = `https://${SOURCE_HOST}`;
const MIRROR_DOMAIN = process.env.MIRROR_DOMAIN || ""; // e.g. mirror.example.com
const MIRROR_PROTO = process.env.MIRROR_PROTO || "https";
const PORT = parseInt(process.env.PORT, 10) || 3000;

function getMirrorOrigin(req) {
  if (MIRROR_DOMAIN) return `${MIRROR_PROTO}://${MIRROR_DOMAIN}`;
  // Auto-detect from reverse proxy / platform headers
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = getMirrorHost(req);
  return `${proto}://${host}`;
}

function getMirrorHost(req) {
  if (MIRROR_DOMAIN) return MIRROR_DOMAIN;
  const raw = req.headers["x-forwarded-host"] || req.headers.host || "";
  // Take first value if comma-separated, strip port for standard ports
  return raw.split(",")[0].trim().replace(/:(?:80|443)$/, "");
}

// ─── Middleware ───────────────────────────────────────────────────
app.set("trust proxy", true);
app.use(compression());

// ─── In-memory cache (simple TTL) ───────────────────────────────
const cache = new Map();
const CACHE_TTL = parseInt(process.env.CACHE_TTL, 10) || 300; // seconds

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key, statusCode, headers, body) {
  cache.set(key, {
    statusCode,
    headers,
    body,
    expires: Date.now() + CACHE_TTL * 1000,
  });
  // Evict old entries if cache grows too large
  if (cache.size > 5000) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// ─── Custom robots.txt ──────────────────────────────────────────
app.get("/robots.txt", (req, res) => {
  const mirrorOrigin = getMirrorOrigin(req);
  res.type("text/plain").send(
    `User-agent: *
Allow: /

Sitemap: ${mirrorOrigin}/sitemap_index.xml
`
  );
});

// ─── Dynamic sitemap proxy & rewrite ────────────────────────────
app.get([
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap*.xml",
  "/news-sitemap.xml",
  "/*-sitemap.xml",
  "/main-sitemap.xsl",
], (req, res) => {
  proxyAndRewrite(req, res, true);
});

// ─── Sportradar widget proxy (domain-license bypass) ────────────
// URL format: /_sr/{sportradar-host}/{path}
// Proxies the request to the specified Sportradar host with original domain headers
// so widgets pass the Sportradar license check.

/**
 * Rewrite all Sportradar domain URLs in text to go through our /_sr/ proxy.
 */
function rewriteSportradarUrls(text) {
  let result = text;
  // https://xxx.sportradar.yyy → /_sr/xxx.sportradar.yyy
  result = result.replace(/https?:\/\/([a-z0-9.-]+\.sportradar\.(?:com|ag|online))/gi, "/_sr/$1");
  // //xxx.sportradar.yyy (protocol-relative, not preceded by : from already-replaced URLs)
  result = result.replace(/(?<![:\w])\/\/([a-z0-9.-]+\.sportradar\.(?:com|ag|online))/gi, "/_sr/$1");
  // Escaped variant in JS strings: https:\/\/xxx.sportradar.yyy → \/_sr\/xxx.sportradar.yyy
  result = result.replace(/https?:\\\/\\\/([a-z0-9.-]+\.sportradar\.(?:com|ag|online))/gi, "\\/_sr\\/$1");
  return result;
}

app.all("/_sr/*", (req, res) => {
  // Parse target host from URL: /_sr/{host}/{path}
  const fullPath = req.originalUrl.replace(/^\/_sr\//, "");
  const slashIdx = fullPath.indexOf("/");
  const srHost = slashIdx >= 0 ? fullPath.substring(0, slashIdx) : fullPath;
  const srPath = slashIdx >= 0 ? fullPath.substring(slashIdx) : "/";

  // Validate host is a Sportradar domain (prevent SSRF)
  if (!/\.sportradar\.(?:com|ag|online)$/i.test(srHost)) {
    return res.status(403).send("Forbidden");
  }

  // Build referer with actual page path from original domain
  const pageReferer = req.headers["referer"] || "";
  const pagePath = pageReferer.replace(/https?:\/\/[^/]+/, "") || "/";

  const headers = {
    host: srHost,
    "user-agent": req.headers["user-agent"] || "Mozilla/5.0",
    accept: req.headers["accept"] || "*/*",
    "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
    referer: SOURCE_ORIGIN + pagePath,
    origin: SOURCE_ORIGIN,
    "accept-encoding": "identity",
  };

  const options = {
    hostname: srHost,
    port: 443,
    path: srPath,
    method: req.method,
    headers,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let chunks = [];
    proxyRes.on("data", (chunk) => chunks.push(chunk));
    proxyRes.on("end", () => {
      const raw = Buffer.concat(chunks);
      const contentType = (proxyRes.headers["content-type"] || "").toLowerCase();

      const respHeaders = {};
      const skipHeaders = new Set([
        "content-encoding", "content-length", "transfer-encoding",
        "connection", "keep-alive", "set-cookie",
        "access-control-allow-origin",
      ]);

      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (skipHeaders.has(key)) continue;
        respHeaders[key] = val;
      }

      respHeaders["access-control-allow-origin"] = "*";

      let body;
      if (
        contentType.includes("javascript") ||
        contentType.includes("json") ||
        contentType.includes("text")
      ) {
        // Rewrite ALL Sportradar domain URLs so subsequent requests also go through our proxy
        body = rewriteSportradarUrls(raw.toString("utf-8"));
      } else {
        body = raw;
      }

      const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
      respHeaders["content-length"] = bodyBuf.length;

      for (const [k, v] of Object.entries(respHeaders)) res.setHeader(k, v);
      res.status(proxyRes.statusCode).send(bodyBuf);
    });
  });

  proxyReq.on("error", (err) => {
    console.error("SR proxy error:", err.message);
    res.status(502).send("Bad Gateway");
  });

  if (req.method !== "GET" && req.method !== "HEAD") {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
});

// ─── All other routes ───────────────────────────────────────────
app.use((req, res) => {
  proxyAndRewrite(req, res, false);
});

// ─── Core proxy function ────────────────────────────────────────
function proxyAndRewrite(req, res, isSitemap) {
  const cacheKey = req.method + ":" + req.originalUrl;

  // Only cache GET requests
  if (req.method === "GET") {
    const cached = getCached(cacheKey);
    if (cached) {
      for (const [k, v] of Object.entries(cached.headers)) {
        res.setHeader(k, v);
      }
      return res.status(cached.statusCode).send(cached.body);
    }
  }

  const targetUrl = new URL(req.originalUrl, SOURCE_ORIGIN);

  const headers = {};
  // Only forward safe headers to origin
  const safeHeaders = ["accept", "accept-language", "user-agent", "referer", "cookie", "range"];
  for (const h of safeHeaders) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }
  headers["host"] = SOURCE_HOST;
  headers["accept-encoding"] = "identity"; // get uncompressed so we can rewrite

  const options = {
    hostname: SOURCE_HOST,
    port: 443,
    path: targetUrl.pathname + targetUrl.search,
    method: req.method,
    headers,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let chunks = [];

    proxyRes.on("data", (chunk) => chunks.push(chunk));

    proxyRes.on("end", () => {
      const raw = Buffer.concat(chunks);
      const contentType = (proxyRes.headers["content-type"] || "").toLowerCase();
      const statusCode = proxyRes.statusCode;
      const mirrorOrigin = getMirrorOrigin(req);
      const mirrorHost = getMirrorHost(req);

      // Build response headers
      const respHeaders = {};
      const skipHeaders = new Set([
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
        "set-cookie",
        "alt-svc",
        "strict-transport-security",
        "content-security-policy",
        "x-frame-options",
      ]);

      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (skipHeaders.has(key)) continue;
        respHeaders[key] = val;
      }

      // Force upgrade-insecure-requests to prevent mixed content
      respHeaders["content-security-policy"] = "upgrade-insecure-requests";

      // Rewrite Location header on redirects
      if (proxyRes.headers["location"]) {
        respHeaders["location"] = rewriteUrl(
          proxyRes.headers["location"],
          mirrorOrigin,
          mirrorHost
        );
      }

      // Handle redirect-only responses (no body rewriting needed)
      if (statusCode >= 300 && statusCode < 400) {
        for (const [k, v] of Object.entries(respHeaders)) res.setHeader(k, v);
        return res.status(statusCode).end();
      }

      let body;

      if (contentType.includes("text/html")) {
        body = rewriteHtml(raw.toString("utf-8"), mirrorOrigin, mirrorHost, req.originalUrl);
      } else if (contentType.includes("text/css")) {
        body = rewriteCss(raw.toString("utf-8"), mirrorOrigin, mirrorHost);
      } else if (
        contentType.includes("javascript") ||
        contentType.includes("application/json")
      ) {
        body = rewriteGenericText(raw.toString("utf-8"), mirrorOrigin, mirrorHost);
      } else if (contentType.includes("xml")) {
        body = rewriteXml(raw.toString("utf-8"), mirrorOrigin, mirrorHost);
      } else {
        // Binary content (images, fonts, etc.) — pass through
        body = raw;
      }

      const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
      respHeaders["content-length"] = bodyBuf.length;

      // Cache GET responses
      if (req.method === "GET" && statusCode >= 200 && statusCode < 400) {
        setCache(cacheKey, statusCode, respHeaders, bodyBuf);
      }

      for (const [k, v] of Object.entries(respHeaders)) res.setHeader(k, v);
      res.status(statusCode).send(bodyBuf);
    });
  });

  proxyReq.on("error", (err) => {
    console.error("Proxy error:", err.message);
    res.status(502).send("Bad Gateway");
  });

  // Pipe request body for POST/PUT etc
  if (req.method !== "GET" && req.method !== "HEAD") {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

// ─── URL rewriting helpers ──────────────────────────────────────

/**
 * Rewrite a single URL string, replacing the source domain with mirror domain.
 */
function rewriteUrl(url, mirrorOrigin, mirrorHost) {
  if (!url) return url;
  let result = url;
  // https://www.crossingbroad.com/... → mirrorOrigin/...
  result = result.split(SOURCE_ORIGIN).join(mirrorOrigin);
  // http://www.crossingbroad.com/...
  result = result.split(`http://${SOURCE_HOST}`).join(mirrorOrigin);
  // //www.crossingbroad.com/...
  result = result.split(`//${SOURCE_HOST}`).join(`//${mirrorHost}`);
  return result;
}

/**
 * Global text-level replacement of source domain references.
 */
function rewriteGenericText(text, mirrorOrigin, mirrorHost) {
  let result = text;
  // Replace all variations of the source domain
  result = result.split(SOURCE_ORIGIN).join(mirrorOrigin);
  result = result.split(`http://${SOURCE_HOST}`).join(mirrorOrigin);
  result = result.split(`//${SOURCE_HOST}`).join(`//${mirrorHost}`);
  result = result.split(SOURCE_HOST).join(mirrorHost);
  // Handle URL-encoded versions  
  const encodedSource = encodeURIComponent(SOURCE_ORIGIN);
  const encodedMirror = encodeURIComponent(mirrorOrigin);
  result = result.split(encodedSource).join(encodedMirror);
  // Handle escaped URLs (in JSON or inline JS)
  result = result.split(SOURCE_ORIGIN.replace(/\//g, "\\/")).join(mirrorOrigin.replace(/\//g, "\\/"));
  result = result.split(`\\/\\/${SOURCE_HOST}`).join(`\\/\\/${mirrorHost}`);
  return result;
}

/**
 * Rewrite CSS url() references.
 */
function rewriteCss(css, mirrorOrigin, mirrorHost) {
  return rewriteGenericText(css, mirrorOrigin, mirrorHost);
}

/**
 * Rewrite XML (sitemaps, RSS feeds, etc.)
 */
function rewriteXml(xml, mirrorOrigin, mirrorHost) {
  return rewriteGenericText(xml, mirrorOrigin, mirrorHost);
}

/**
 * Full HTML rewriting with Cheerio for precision.
 */
function rewriteHtml(html, mirrorOrigin, mirrorHost, pagePath) {
  // First, do global text-level replacements
  let rewritten = rewriteGenericText(html, mirrorOrigin, mirrorHost);

  // Rewrite Sportradar widget URLs to use our proxy (fixes "Domain not licensed" error)
  rewritten = rewriteSportradarUrls(rewritten);

  const $ = cheerio.load(rewritten, { decodeEntities: false });

  // ── 1. Canonical tag: ensure it points to mirror ──
  const canonicalUrl = mirrorOrigin + pagePath.split("?")[0];
  let canonical = $('link[rel="canonical"]');
  if (canonical.length) {
    canonical.attr("href", canonicalUrl);
  } else {
    $("head").append(`<link rel="canonical" href="${escapeAttr(canonicalUrl)}" />`);
  }

  // ── 2. Meta tags for SEO dedup ──
  // og:url
  let ogUrl = $('meta[property="og:url"]');
  if (ogUrl.length) {
    ogUrl.attr("content", canonicalUrl);
  }

  // twitter:url
  let twUrl = $('meta[name="twitter:url"]');
  if (twUrl.length) {
    twUrl.attr("content", canonicalUrl);
  }

  // ── 3. Remove third-party ad/tracking scripts that cause console errors on mirror ──
  const blockedScriptDomains = [
    "api.omappapi.com",       // OptinMonster
    "a.omappapi.com",         // OptinMonster
    "optinmonster.com",       // OptinMonster
    "btloader.com",           // BlockThrough ad recovery
    "pub.network",            // Freestar
    "freestar.com",           // Freestar ads
    "pubfig.min.js",          // Freestar pubfig
    "rp.liadm.com",           // LiveRamp
    "liadm.com",              // LiveRamp
    "na.edge.optable.co",     // Optable
    "api.rlcdn.com",          // RLCdn identity
    "match.rundsp.com",       // RunDSP
    "ads.stickyadstv.com",    // StickyAds
    "x.bidswitch.net",        // Bidswitch
    "eb2.3lift.com",          // TripleLift
    "pixel-sync.sitescout.com", // SiteScout
    "j.mrpdata.net",          // MRP Data
    "id5-sync.com",           // ID5
    "sync-apac-v4.intentiq.com", // IntentIQ
    "sekindo.com",            // Sekindo/Primis
    "live.primis.tech",       // Primis
    "primis.tech",            // Primis
    "priv.center",            // Truendo privacy
    "truendo",                // Truendo consent
  ];

  // Remove <script> tags that load from blocked domains
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src") || "";
    if (blockedScriptDomains.some((d) => src.includes(d))) {
      $(el).remove();
    }
  });

  // Remove inline <script> tags that reference blocked domains or keywords
  const blockedInlineKeywords = [
    ...blockedScriptDomains,
    "var freestar",
    "freestar.queue",
    "freestar.config",
  ];
  $("script:not([src])").each((_, el) => {
    const content = $(el).html() || "";
    if (blockedInlineKeywords.some((d) => content.includes(d))) {
      $(el).remove();
    }
  });

  // Remove <link> tags (any rel) pointing to blocked domains
  $("link[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (blockedScriptDomains.some((d) => href.includes(d))) {
      $(el).remove();
    }
  });

  // Remove <iframe> pointing to blocked domains
  $("iframe[src]").each((_, el) => {
    const src = $(el).attr("src") || "";
    if (blockedScriptDomains.some((d) => src.includes(d))) {
      $(el).remove();
    }
  });

  // Remove ad placeholder divs
  $("[data-freestar-ad]").remove();

  // Remove scripts with IDs or src paths referencing blocked plugins
  $("script[id*='optinmonster'], script[src*='/plugins/optinmonster/']").remove();

  // Remove OptinMonster specific elements and HTML comments
  $("#om-holder, .om-holder, [id^='om-']").remove();

  // Remove jQuery Migrate console warning by injecting a small fixup
  $("head").append('<script>if(window.jQuery&&window.jQuery.migrateWarnings){window.jQuery.migrateWarnings=[];window.jQuery.migrateMute=true;}</script>');

  // ── 4. Rewrite href/src/action/srcset attributes ──
  const urlAttrs = [
    { sel: "a[href]", attr: "href" },
    { sel: "link[href]", attr: "href" },
    { sel: "img[src]", attr: "src" },
    { sel: "img[srcset]", attr: "srcset" },
    { sel: "script[src]", attr: "src" },
    { sel: "source[src]", attr: "src" },
    { sel: "source[srcset]", attr: "srcset" },
    { sel: "video[src]", attr: "src" },
    { sel: "audio[src]", attr: "src" },
    { sel: "iframe[src]", attr: "src" },
    { sel: "form[action]", attr: "action" },
    { sel: "object[data]", attr: "data" },
    { sel: "embed[src]", attr: "src" },
  ];

  for (const { sel, attr } of urlAttrs) {
    $(sel).each((_, el) => {
      const val = $(el).attr(attr);
      if (!val) return;

      if (attr === "srcset") {
        // srcset is comma-separated: "url1 1x, url2 2x"
        const rewrittenSrcset = val
          .split(",")
          .map((entry) => {
            const parts = entry.trim().split(/\s+/);
            parts[0] = rewriteUrl(parts[0], mirrorOrigin, mirrorHost);
            return parts.join(" ");
          })
          .join(", ");
        $(el).attr(attr, rewrittenSrcset);
      } else {
        $(el).attr(attr, rewriteUrl(val, mirrorOrigin, mirrorHost));
      }
    });
  }

  // ── 5. Rewrite JSON-LD structured data ──
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      let jsonText = $(el).html();
      if (jsonText) {
        jsonText = rewriteGenericText(jsonText, mirrorOrigin, mirrorHost);
        $(el).html(jsonText);
      }
    } catch (e) {
      // Skip malformed JSON-LD
    }
  });

  // ── 6. Rewrite inline styles with url() ──
  $("[style]").each((_, el) => {
    const style = $(el).attr("style");
    if (style && style.includes(SOURCE_HOST)) {
      $(el).attr("style", rewriteGenericText(style, mirrorOrigin, mirrorHost));
    }
  });

  // ── 7. Rewrite data-* attributes that may contain URLs ──
  $("*").each((_, el) => {
    const attribs = el.attribs || {};
    for (const [key, val] of Object.entries(attribs)) {
      if (key.startsWith("data-") && typeof val === "string" && val.includes(SOURCE_HOST)) {
        $(el).attr(key, rewriteGenericText(val, mirrorOrigin, mirrorHost));
      }
    }
  });

  // ── 8. Rewrite <base> tag ──
  const baseTag = $("base[href]");
  if (baseTag.length) {
    baseTag.attr("href", rewriteUrl(baseTag.attr("href"), mirrorOrigin, mirrorHost));
  }

  // ── 9. Rewrite <style> tag contents ──
  $("style").each((_, el) => {
    const css = $(el).html();
    if (css) {
      $(el).html(rewriteGenericText(css, mirrorOrigin, mirrorHost));
    }
  });

  // ── 10. Rewrite <noscript> contents ──
  $("noscript").each((_, el) => {
    const inner = $(el).html();
    if (inner && inner.includes(SOURCE_HOST)) {
      $(el).html(rewriteGenericText(inner, mirrorOrigin, mirrorHost));
    }
  });

  // ── 11. Remove preconnect/dns-prefetch to source ──
  $(`link[rel="preconnect"][href*="${SOURCE_HOST}"]`).remove();
  $(`link[rel="dns-prefetch"][href*="${SOURCE_HOST}"]`).remove();

  // ── 12. Add X-Robots-Tag equivalent meta ──
  if (!$('meta[name="robots"]').length) {
    $('head').append('<meta name="robots" content="index, follow" />');
  }

  // ── 13. Final pass: force all remaining http:// mirror URLs to correct protocol ──
  let finalHtml = $.html();
  const mirrorProto = mirrorOrigin.split("://")[0];
  if (mirrorProto === "https") {
    finalHtml = finalHtml.split(`http://${mirrorHost}`).join(`https://${mirrorHost}`);
  }

  // Strip HTML comments referencing blocked services
  const blockedCommentPatterns = ["OptinMonster", "Freestar", "TRUENDO", "Primis"];
  for (const pat of blockedCommentPatterns) {
    const re = new RegExp("<!--(?:(?!-->)[\\s\\S])*" + pat + "(?:(?!-->)[\\s\\S])*-->", "gi");
    finalHtml = finalHtml.replace(re, "");
  }

  return finalHtml;
}

/**
 * Escape a string for use in HTML attributes.
 */
function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Health check ───────────────────────────────────────────────
app.get("/_health", (req, res) => {
  res.json({ status: "ok", source: SOURCE_HOST });
});

// ─── Start server ───────────────────────────────────────────────
const server = http.createServer(app);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Mirror proxy running on port ${PORT}`);
  console.log(`Source: ${SOURCE_ORIGIN}`);
  console.log(`Mirror domain: ${MIRROR_DOMAIN || "(auto-detect from Host header)"}`);
});
