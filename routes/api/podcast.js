const http = require("http");
const https = require("https");
const zlib = require("zlib");
const dns = require("dns").promises;
const net = require("net");
const { createHash } = require("crypto");
const { XMLParser } = require("fast-xml-parser");
const sanitizeHtml = require("sanitize-html");
const { decode } = require("he");
const { Router } = require("express");

const router = Router();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

const MAX_REDIRECTS = 3;
const PER_PAGE = 10;
const MAX_LIMIT = 50;
const PODCAST_CACHE_SECONDS = 60 * 60 * 48;
const EPISODES_CACHE_SECONDS = 60 * 60 * 36;
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RSS_BYTES = 5 * 1024 * 1024;
const DEBUG = process.env.DEBUG_RSS === "1";
const BLOCKQUOTE_OPEN_TOKEN = "__BLOCKQUOTE_OPEN__";
const BLOCKQUOTE_CLOSE_TOKEN = "__BLOCKQUOTE_CLOSE__";

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

const buildEpisodeId = (episode = {}) => {
  const fallbackSource = `${episode.title || ""}-${episode.publishedAt || ""}-${episode.audio || ""}`;
  const source =
    episode.guid ||
    episode.id ||
    episode.uid ||
    episode.audio ||
    episode.url ||
    episode.link ||
    fallbackSource;
  return createHash("sha256").update(String(source)).digest("hex");
};

const escapeHtml = (value = "") => {
  const text = value == null ? "" : String(value);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const addReadableSpacing = (value = "") => {
  const text = value == null ? "" : String(value);
  return text
    .replace(/([\u4e00-\u9fa5])([A-Za-z0-9])/g, "$1 $2")
    .replace(/([A-Za-z0-9])([\u4e00-\u9fa5])/g, "$1 $2");
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

const convertHtmlToPlainText = (value = "") => {
  const text = value == null ? "" : String(value);
  return text
    .replace(/<strong[^>]*>/gi, "__STRONG_OPEN__")
    .replace(/<\/strong>/gi, "__STRONG_CLOSE__")
    .replace(/<b[^>]*>/gi, "__STRONG_OPEN__")
    .replace(/<\/b>/gi, "__STRONG_CLOSE__")
    .replace(/<em[^>]*>/gi, "__EM_OPEN__")
    .replace(/<\/em>/gi, "__EM_CLOSE__")
    .replace(/<i[^>]*>/gi, "__EM_OPEN__")
    .replace(/<\/i>/gi, "__EM_CLOSE__")
    .replace(/<blockquote[^>]*>/gi, `\n\n${BLOCKQUOTE_OPEN_TOKEN}\n\n`)
    .replace(/<\/blockquote>/gi, `\n\n${BLOCKQUOTE_CLOSE_TOKEN}\n\n`)
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n\n")
    .replace(/<\s*(h[1-6]|section|article)[^>]*>/gi, "\n\n")
    .replace(/<\/\s*(h[1-6]|section|article)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const applyFormattingTokens = (input) => {
  if (!input) {
    return "";
  }
  const tokens = [
    { open: "__STRONG_OPEN__", close: "__STRONG_CLOSE__", tag: "strong" },
    { open: "__EM_OPEN__", close: "__EM_CLOSE__", tag: "em" },
  ];

  let output = input;

  tokens.forEach(({ open, close, tag }) => {
    let result = "";
    let remaining = output;
    let depth = 0;

    while (remaining.length) {
      const openIndex = remaining.indexOf(open);
      const closeIndex = remaining.indexOf(close);

      if (openIndex === -1 && closeIndex === -1) {
        result += remaining;
        break;
      }

      const useOpen = openIndex !== -1 && (closeIndex === -1 || openIndex < closeIndex);
      const tokenIndex = useOpen ? openIndex : closeIndex;
      const tokenLength = useOpen ? open.length : close.length;

      result += remaining.slice(0, tokenIndex);
      remaining = remaining.slice(tokenIndex + tokenLength);

      if (useOpen) {
        depth += 1;
        result += `<${tag}>`;
      } else if (depth > 0) {
        depth -= 1;
        result += `</${tag}>`;
      }
    }

    while (depth > 0) {
      result += `</${tag}>`;
      depth -= 1;
    }

    output = result;
  });

  return output;
};

const highlightTimestampsInPlainText = (html) => {
  return html.replace(/(^|[^0-9])(\d{1,2}:\d{2}(?::\d{2})?)(?![0-9:])/g, (match, prefix, time) => {
    return `${prefix}<button class="timestamp" type="button" data-timestamp="${time}">${time}</button>`;
  });
};

const highlightTimestampsInHtml = (html) => {
  if (!html) {
    return "";
  }
  const parts = String(html).split(/(<[^>]+>)/g);
  const stack = [];
  let timestampDepth = 0;
  const isSelfClosing = (tag) => /\/\s*>$/.test(tag) || /^<\s*(br|hr)\b/i.test(tag);
  const isTimestampTag = (tag) => {
    return (
      /\bclass\s*=\s*["'][^"']*\btimestamp\b[^"']*["']/i.test(tag) ||
      /\bdata-timestamp\s*=/i.test(tag)
    );
  };

  return parts
    .map((segment) => {
      if (!segment) {
        return "";
      }
      if (segment.startsWith("<")) {
        const closingMatch = segment.match(/^<\s*\/\s*([a-z0-9:-]+)/i);
        if (closingMatch) {
          const last = stack.pop();
          if (last) {
            timestampDepth = Math.max(0, timestampDepth - 1);
          }
          return segment;
        }
        if (isSelfClosing(segment)) {
          return segment;
        }
        const isTimestamp = isTimestampTag(segment);
        stack.push(isTimestamp);
        if (isTimestamp) {
          timestampDepth += 1;
        }
        return segment;
      }

      if (timestampDepth > 0) {
        return segment;
      }

      return segment.replace(/(\d{1,2}:\d{2}(?::\d{2})?)/g, (match) => {
        const trimmed = match.trim();
        if (!trimmed) {
          return match;
        }
        return `<button class="timestamp" type="button" data-timestamp="${trimmed}">${trimmed}</button>`;
      });
    })
    .join("");
};

const buildHtmlFromPlainText = (text, escapeHtmlFn) => {
  if (!text) {
    return "";
  }
  const paragraphs = text
    .split(/\n{2,}/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!paragraphs.length) {
    return "";
  }

  const wrapParagraph = (paragraph) => {
    const safe = escapeHtmlFn(paragraph).replace(/\n/g, "<br />");
    return `<p>${highlightTimestampsInPlainText(applyFormattingTokens(safe))}</p>`;
  };

  const htmlParagraphs = [];
  let blockquoteBuffer = [];
  let insideBlockquote = false;

  const flushBlockquote = () => {
    if (!blockquoteBuffer.length) {
      insideBlockquote = false;
      blockquoteBuffer = [];
      return;
    }
    htmlParagraphs.push(`<blockquote>${blockquoteBuffer.join("")}</blockquote>`);
    insideBlockquote = false;
    blockquoteBuffer = [];
  };

  paragraphs.forEach((paragraph) => {
    if (paragraph === BLOCKQUOTE_OPEN_TOKEN) {
      if (insideBlockquote && blockquoteBuffer.length) {
        flushBlockquote();
      }
      insideBlockquote = true;
      return;
    }
    if (paragraph === BLOCKQUOTE_CLOSE_TOKEN) {
      if (insideBlockquote) {
        flushBlockquote();
      }
      return;
    }
    const wrapped = wrapParagraph(paragraph);
    if (insideBlockquote) {
      blockquoteBuffer.push(wrapped);
    } else {
      htmlParagraphs.push(wrapped);
    }
  });

  if (insideBlockquote && blockquoteBuffer.length) {
    flushBlockquote();
  }

  if (!htmlParagraphs.length) {
    return "";
  }
  return `<div class="episode-detail-description">${htmlParagraphs.join("")}</div>`;
};

const buildEpisodeDescriptionHtml = (options = {}) => {
  const { html, fallbackText, escapeHtml: escapeHtmlFn } = options;
  const safeEscape = typeof escapeHtmlFn === "function" ? escapeHtmlFn : (value) => value;
  const sanitizedHtml = html ? String(html).trim() : "";
  if (sanitizedHtml) {
    return `<div class="episode-detail-description">${highlightTimestampsInHtml(sanitizedHtml)}</div>`;
  }

  const safeFallback = fallbackText ? String(fallbackText).trim() : "";
  if (!safeFallback) {
    return "";
  }
  return buildHtmlFromPlainText(safeFallback, safeEscape);
};

const toRichHtml = (value) => {
  const decoded = decodeHtml(value);
  if (!decoded) {
    return "";
  }

  return cleanEmptyHtml(sanitizeHtml(decoded, sanitizeOptions)).trim();
};

const cleanEmptyHtml = (html) => {
  if (!html) return "";
  let output = html;
  const emptyTagPattern =
    /<(span|p|div|section|article|strong|b|em|i|u|blockquote|code|pre|figure|figcaption)\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>/gi;
  let previous;
  do {
    previous = output;
    output = output.replace(emptyTagPattern, "");
  } while (output !== previous);
  return output.replace(/(?:<br\s*\/?>\s*){2,}/gi, "<br />").trim();
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

  const rawDescription =
    channel?.["itunes:summary"] ||
    channel?.description ||
    channel?.["itunes:subtitle"] ||
    "";
  const descriptionHtml = toRichHtml(rawDescription) || "";
  const descriptionText = toText(rawDescription) || "";

  return {
    name,
    author,
    rss: rssUrl,
    image,
    website,
    description_html: descriptionHtml,
    description_text: descriptionText,
  };
};

const hasPodcastInfo = (podcast) =>
  Boolean(
    podcast &&
      (podcast.name ||
        podcast.author ||
        podcast.image ||
        podcast.website ||
        podcast.description_html ||
        podcast.description_text),
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
    const fallbackDescriptionText = addReadableSpacing(convertHtmlToPlainText(rawDescription)).trim();
    const descriptionWithTimestamps = buildEpisodeDescriptionHtml({
      html: descriptionHtml,
      fallbackText: fallbackDescriptionText,
      escapeHtml,
    });
    const publishedAt = parseTimestamp(item?.pubDate || item?.["dc:date"] || "");
    const title = item?.title || `Episode ${start + index + 1}`;
    const rawGuid = item?.guid;
    const rawId = item?.id;
    const rawUid = item?.uid;
    const guidValue = toLink(rawGuid) || (typeof rawGuid === "string" ? rawGuid.trim() : "");
    const idValue = toLink(rawId) || (typeof rawId === "string" ? rawId.trim() : "");
    const uidValue = toLink(rawUid) || (typeof rawUid === "string" ? rawUid.trim() : "");
    const audioUrl = enclosure?.["@_url"] || enclosure?.url || "";
    const idSource = {
      guid: guidValue,
      id: idValue,
      uid: uidValue,
      audio: audioUrl,
      url: episodeLink,
      link: episodeLink,
      title,
      publishedAt,
    };
    const episodePayload = {
      title,
      author,
      publishedAt,
      duration: item?.["itunes:duration"] || item?.duration || "",
      audio: audioUrl,
      image,
      description_html: descriptionWithTimestamps,
      description_text: toText(rawDescription),
      url: episodeLink,
      link: episodeLink,
      guid: guidValue || idValue || uidValue || "",
    };
    const episodeId = buildEpisodeId(idSource);

    return {
      id: episodeId,
      ...episodePayload,
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
  const cursor = getQueryParam(req.query?.cursor);
  const limit = getQueryParam(req.query?.limit);
  const refresh = getQueryParam(req.query?.refresh);

  if (!url) {
    res.status(400).json({ error: "请提供 RSS 地址(url)" });
    return;
  }

  const parsedCursor = Number.parseInt(cursor ?? "0", 10);
  const parsedLimit = Number.parseInt(limit ?? String(PER_PAGE), 10);
  const safeCursor = Number.isNaN(parsedCursor) || parsedCursor < 0 ? 0 : parsedCursor;
  const safeLimit =
    Number.isNaN(parsedLimit) || parsedLimit < 1
      ? PER_PAGE
      : Math.min(parsedLimit, MAX_LIMIT);
  const bypassCache = isRefreshRequested(refresh);
  const start = safeCursor;

  try {
    const parsed = await parseRssFeed(url);
    const podcast = extractPodcastInfo(parsed, url);
    const { total, episodes } = extractEpisodesPage(parsed, start, safeLimit);
    const hasMore = start + episodes.length < total;
    const nextCursor = hasMore ? start + episodes.length : null;
    const paginated = episodes;

    if (bypassCache || paginated.length === 0) {
      disableCache(res);
    } else {
      setCacheHeader(res, EPISODES_CACHE_SECONDS);
    }

    res.json({
      podcast,
      pagination: {
        cursor: start,
        limit: safeLimit,
        nextCursor,
        hasMore,
      },
      episodes: paginated,
    });
  } catch (error) {
    disableCache(res);
    res.status(502).json({ error: error.message || "解析 RSS 失败" });
  }
});

module.exports = router;
