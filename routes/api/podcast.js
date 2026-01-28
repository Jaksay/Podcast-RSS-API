const http = require("http");
const https = require("https");
const zlib = require("zlib");
const dns = require("dns").promises;
const net = require("net");
const { XMLParser } = require("fast-xml-parser");
const sanitizeHtml = require("sanitize-html");
const { decode } = require("he");
const { Router } = require("express");

const router = Router();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

const MAX_REDIRECTS = 3;
const PER_PAGE = 10;
const PODCAST_CACHE_SECONDS = 60 * 60 * 5;
const EPISODES_CACHE_SECONDS = 60 * 60 * 36;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RSS_BYTES = 5 * 1024 * 1024;
const DEBUG = process.env.DEBUG_RSS === "1";

const logDebug = (...args) => {
  if (!DEBUG) return;
  console.log("[rss]", ...args);
};

const ensureArray = (value) => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const getQueryParam = (value) => (Array.isArray(value) ? value[0] : value);

const isRefreshRequested = (value) => {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return isRefreshRequested(value[0]);
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "no"].includes(normalized);
};

const setCacheHeader = (res, seconds) => {
  res.set("Cache-Control", `public, s-maxage=${seconds}, max-age=0`);
};

const disableCache = (res) => {
  res.set("Cache-Control", "no-store");
};

const parseTimestamp = (value) => {
  if (!value) return null;
  const date = new Date(value);
  const timestamp = date.getTime();
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return timestamp;
};

const sanitizeOptions = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "b",
    "em",
    "i",
    "u",
    "ul",
    "ol",
    "li",
    "a",
    "blockquote",
    "code",
    "pre",
    "span",
    "hr",
    "sup",
    "sub",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "dl",
    "dt",
    "dd",
    "figure",
    "figcaption",
    "img",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    td: ["colspan", "rowspan"],
    th: ["colspan", "rowspan"],
    "*": [],
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: (tagName, attribs) => ({
      tagName: "a",
      attribs: {
        ...attribs,
        target: "_blank",
        rel: "noopener noreferrer",
      },
    }),
  },
  textFilter: (text) => text,
};

const decodeHtml = (value) => {
  if (!value || typeof value !== "string") {
    return "";
  }
  return decode(value, { isAttributeValue: false, strict: false });
};

const toText = (value) => {
  const decoded = decodeHtml(value);
  if (!decoded) {
    return "";
  }
  return decoded
    .replace(/<(br|BR)\s*\/?>/g, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const toRichHtml = (value) => {
  const decoded = decodeHtml(value);
  if (!decoded) {
    return "";
  }

  return sanitizeHtml(decoded, sanitizeOptions).trim();
};

const toLink = (value) => {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return decodeHtml(value).trim();
  }
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      return value.length ? toLink(value[0]) : "";
    }
    if (typeof value?.["@_href"] === "string") {
      return decodeHtml(value["@_href"]).trim();
    }
    if (typeof value?.url === "string") {
      return decodeHtml(value.url).trim();
    }
    if (typeof value?.["#text"] === "string") {
      return decodeHtml(value["#text"]).trim();
    }
  }
  return "";
};

const isPrivateIp = (ip) => {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map((part) => Number.parseInt(part, 10));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === "::1") return true;
    if (normalized.startsWith("fe80:")) return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.replace("::ffff:", "");
      if (net.isIP(mapped) === 4) return isPrivateIp(mapped);
    }
  }

  return false;
};

const ensurePublicUrl = (parsedUrl) => {
  if (!parsedUrl || !parsedUrl.hostname) {
    throw new Error("无效的 RSS 地址");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("仅支持 http/https RSS 地址");
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("禁止访问本地地址");
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("禁止访问内网地址");
    }
    return;
  }
};

const resolvePublicAddress = async (hostname) => {
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses || addresses.length === 0) {
    throw new Error("DNS 解析失败");
  }
  const publicAddress = addresses.find((record) => !isPrivateIp(record.address));
  if (!publicAddress) {
    throw new Error("禁止访问内网地址");
  }
  return publicAddress;
};

const createStaticLookup = (address, family) => (hostname, options, callback) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  const wantsAll = Boolean(options?.all);
  if (wantsAll) {
    callback(null, [{ address, family }]);
    return;
  }

  callback(null, address, family);
};

const fetchRss = async (targetUrl, redirectCount = 0) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch (error) {
    throw new Error("无效的 RSS 地址");
  }

  ensurePublicUrl(parsedUrl);

  const httpClient = parsedUrl.protocol === "https:" ? https : http;
  const hostname = parsedUrl.hostname.toLowerCase();
  let lookup;

  if (!net.isIP(hostname)) {
    const resolved = await resolvePublicAddress(hostname);
    logDebug("lookup ok", { hostname, address: resolved.address });
    const family = net.isIP(resolved.address);
    lookup = createStaticLookup(resolved.address, family);
  }
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    logDebug("fetch start", parsedUrl.href);
    const request = httpClient.get(
      parsedUrl,
      {
        headers: {
          "User-Agent": "Express-Podcast-RSS-Parser",
          Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
        },
        ...(lookup ? { lookup } : {}),
      },
      (response) => {
        const { statusCode, headers } = response;
        logDebug("response", {
          url: parsedUrl.href,
          statusCode,
          contentType: headers["content-type"],
          contentEncoding: headers["content-encoding"],
        });

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            reject(new Error("RSS 地址重定向次数过多"));
            return;
          }
          const nextUrl = headers.location.startsWith("http")
            ? headers.location
            : new URL(headers.location, parsedUrl).href;
          resolve(fetchRss(nextUrl, redirectCount + 1));
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`获取 RSS 失败，状态码 ${statusCode}`));
          return;
        }

        const chunks = [];
        let totalBytes = 0;
        response.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_RSS_BYTES) {
            response.destroy();
            reject(new Error("RSS 内容过大"));
            return;
          }
          chunks.push(chunk);
        });
          response.on("end", () => {
            if (totalBytes > MAX_RSS_BYTES) return;
            const buffer = Buffer.concat(chunks);
            const encoding = headers["content-encoding"];

          const finish = (err, decoded) => {
            if (err) {
              reject(new Error("解压 RSS 内容失败"));
              return;
            }
            logDebug("fetch success", {
              url: parsedUrl.href,
              bytes: totalBytes,
              ms: Date.now() - startedAt,
            });
            resolve(decoded.toString("utf8"));
          };

          if (encoding === "gzip") {
            zlib.gunzip(buffer, finish);
          } else if (encoding === "deflate") {
            zlib.inflate(buffer, finish);
          } else if (encoding === "br") {
            zlib.brotliDecompress(buffer, finish);
          } else {
            resolve(buffer.toString("utf8"));
          }
        });
      },
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      logDebug("timeout", {
        url: parsedUrl.href,
        ms: Date.now() - startedAt,
      });
      request.destroy(new Error("请求 RSS 超时"));
    });

    request.on("error", (error) => {
      logDebug("error", {
        url: parsedUrl.href,
        message: error?.message,
        ms: Date.now() - startedAt,
      });
      if (error?.message) {
        reject(new Error(error.message));
        return;
      }
      reject(new Error("请求 RSS 地址失败"));
    });
  });
};

const parseRssFeed = async (url) => {
  const xmlContent = await fetchRss(url);
  return parser.parse(xmlContent);
};

const getChannelInfo = (rssData = {}) => rssData?.rss?.channel || {};

const extractPodcastInfo = (rssData = {}, rssUrl) => {
  const channel = getChannelInfo(rssData);

  const name = channel?.title || "";
  const author =
    channel?.["itunes:author"] ||
    channel?.author ||
    channel?.managingEditor ||
    "";

  const image =
    channel?.["itunes:image"]?.["@_href"] ||
    channel?.image?.url ||
    channel?.["itunes:image"] ||
    "";

  const website =
    channel?.link ||
    channel?.["itunes:link"] ||
    (Array.isArray(channel?.link) ? channel?.link?.[0] : "");

  const description =
    toRichHtml(
      channel?.["itunes:summary"] ||
        channel?.description ||
        channel?.["itunes:subtitle"] ||
        "",
    ) || "";

  return {
    name,
    author,
    rss: rssUrl,
    image,
    website,
    description,
  };
};

const hasPodcastInfo = (podcast) =>
  Boolean(
    podcast &&
      (podcast.name ||
        podcast.author ||
        podcast.image ||
        podcast.website ||
        podcast.description),
  );

const extractEpisodesPage = (rssData = {}, start = 0, limit = PER_PAGE) => {
  const channel = getChannelInfo(rssData);
  const items = ensureArray(channel?.item);

  const fallbackAuthor =
    channel?.["itunes:author"] ||
    channel?.author ||
    channel?.managingEditor ||
    "";

  const fallbackImage =
    channel?.["itunes:image"]?.["@_href"] ||
    channel?.image?.url ||
    channel?.["itunes:image"] ||
    "";

  const toEnclosure = (enclosure) => {
    if (!enclosure) return {};
    if (Array.isArray(enclosure)) {
      return enclosure[0] || {};
    }
    return enclosure;
  };

  const pageItems = items.slice(start, start + limit);

  const episodes = pageItems.map((item, index) => {
    const enclosure = toEnclosure(item?.enclosure);
    const rawDescription = item?.["content:encoded"] || item?.description || "";
    const descriptionHtml = toRichHtml(rawDescription);
    const image =
      item?.["itunes:image"]?.["@_href"] ||
      item?.image?.url ||
      item?.["itunes:image"] ||
      fallbackImage;

    const author =
      item?.["itunes:author"] ||
      item?.author ||
      item?.creator ||
      fallbackAuthor;
    const episodeLink =
      toLink(item?.link) ||
      toLink(item?.guid) ||
      toLink(item?.["feedburner:origLink"]) ||
      toLink(enclosure?.url) ||
      "";

    const episodeIndex = start + index;
    return {
      title: item?.title || `Episode ${episodeIndex + 1}`,
      author,
      publishedAt: parseTimestamp(item?.pubDate || item?.["dc:date"] || ""),
      duration: item?.["itunes:duration"] || item?.duration || "",
      audio: enclosure?.["@_url"] || enclosure?.url || "",
      image,
      description: descriptionHtml,
      intro: toText(rawDescription),
      url: episodeLink,
      link: episodeLink,
    };
  });

  return { total: items.length, episodes };
};

router.get("/", async (req, res) => {
  const url = getQueryParam(req.query?.url);
  const refresh = getQueryParam(req.query?.refresh);

  if (!url) {
    res.status(400).json({ error: "请提供 RSS 地址(url)" });
    return;
  }

  const bypassCache = isRefreshRequested(refresh);

  try {
    const parsed = await parseRssFeed(url);
    const podcast = extractPodcastInfo(parsed, url);

    if (bypassCache || !hasPodcastInfo(podcast)) {
      disableCache(res);
    } else {
      setCacheHeader(res, PODCAST_CACHE_SECONDS);
    }

    res.json({ podcast });
  } catch (error) {
    disableCache(res);
    res.status(502).json({ error: error.message || "解析 RSS 失败" });
  }
});

router.get("/episodes", async (req, res) => {
  const url = getQueryParam(req.query?.url);
  const page = getQueryParam(req.query?.page);
  const refresh = getQueryParam(req.query?.refresh);

  if (!url) {
    res.status(400).json({ error: "请提供 RSS 地址(url)" });
    return;
  }

  const parsedPage = Number.parseInt(page ?? "1", 10);
  const currentPage = Number.isNaN(parsedPage) || parsedPage < 1 ? 1 : parsedPage;
  const bypassCache = isRefreshRequested(refresh);
  const start = (currentPage - 1) * PER_PAGE;

  try {
    const parsed = await parseRssFeed(url);
    const podcast = extractPodcastInfo(parsed, url);
    const { total, episodes } = extractEpisodesPage(parsed, start, PER_PAGE);
    const totalPages = total === 0 ? 1 : Math.ceil(total / PER_PAGE);
    const paginated = episodes;

    if (bypassCache || paginated.length === 0) {
      disableCache(res);
    } else {
      setCacheHeader(res, EPISODES_CACHE_SECONDS);
    }

    res.json({
      podcast,
      pagination: {
        total,
        perPage: PER_PAGE,
        currentPage,
        totalPages,
      },
      episodes: paginated,
    });
  } catch (error) {
    disableCache(res);
    res.status(502).json({ error: error.message || "解析 RSS 失败" });
  }
});

module.exports = router;
