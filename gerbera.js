// gerbera.js
// Talks to a Gerbera DLNA/UPnP server through its ContentDirectory service.
//
// IMPORTANT — why the custom `agent` below exists:
// Node 19+ keeps HTTP connections alive by default. Gerbera (libupnp) closes
// the connection after every SOAP response, so Node sends the next request
// over an already dead socket and gets "socket hang up". The first request
// succeeds and every following one fails. Hence keep-alive is disabled
// explicitly. Sending a `Connection: close` header does NOT help — Node still
// picks a pooled socket for the next request.

const http = require('http');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const agent = new http.Agent({ keepAlive: false, maxSockets: 4 });

const XML_OPTS = { ignoreAttributes: false, attributeNamePrefix: '@_' };

// Ordinary parser, used for the device description and for DIDL-Lite payloads.
// `entityExpansionLimit` is raised for very large libraries; it is ignored by
// parser versions that predate the option.
const xmlParser = new XMLParser({ ...XML_OPTS, entityExpansionLimit: 1e7 });

// Parser for SOAP envelopes, with entity processing switched OFF.
//
// A ContentDirectory response carries its DIDL-Lite payload inside <Result> as
// an XML-escaped string, so every single markup character arrives as an entity
// — over 7000 of them for a page of 500 items. fast-xml-parser 4.5.3 and newer
// cap entity expansion at 1000 by default (protection against "billion laughs"
// attacks) and abort the parse. Letting the parser expand that payload is
// pointless work anyway: `unescapeXml` below does it in one pass, and the
// result is parsed separately as real XML.
const soapParser = new XMLParser({ ...XML_OPTS, processEntities: false });

/** Expands the five predefined XML entities plus numeric character references. */
function unescapeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    // Must come last, so that "&amp;lt;" survives as the literal text "&lt;".
    .replace(/&amp;/g, '&');
}

const CDS_TYPE = 'urn:schemas-upnp-org:service:ContentDirectory:1';

let cachedControlUrl = null;
let cachedSearchSupported = null;

function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

/** Resolves the ContentDirectory control URL from the device description. */
async function getControlUrl(baseUrl) {
  if (cachedControlUrl) return cachedControlUrl;

  const { data } = await axios.get(`${baseUrl}/description.xml`, { timeout: 8000, httpAgent: agent });
  const parsed = xmlParser.parse(data);

  const device = parsed.root && parsed.root.device;
  if (!device) throw new Error('Could not parse description.xml from the Gerbera server');

  let services = device.serviceList && device.serviceList.service;
  if (!services) throw new Error('The Gerbera server exposes no serviceList in description.xml');
  if (!Array.isArray(services)) services = [services];

  const cds = services.find(s => String(s.serviceType).includes('ContentDirectory'));
  if (!cds) throw new Error('No ContentDirectory service found on the Gerbera server');

  let path = String(cds.controlURL);
  if (!path.startsWith('http')) {
    path = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }
  cachedControlUrl = path;
  return path;
}

/** Raw SOAP call against the ContentDirectory service. */
async function soap(baseUrl, action, innerXml) {
  const controlUrl = await getControlUrl(baseUrl);
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${CDS_TYPE}">${innerXml}</u:${action}>
  </s:Body>
</s:Envelope>`;

  const { data } = await axios.post(controlUrl, body, {
    httpAgent: agent,
    timeout: 60000,
    maxContentLength: 200 * 1024 * 1024,
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'SOAPAction': `"${CDS_TYPE}#${action}"`,
    },
  });

  const env = soapParser.parse(data)['s:Envelope'];
  if (!env) throw new Error(`Unexpected SOAP response to ${action}`);
  const resp = env['s:Body'][`u:${action}Response`];
  if (!resp) throw new Error(`No ${action}Response in the Gerbera server reply`);
  return resp;
}

/**
 * Extracts DIDL-Lite containers and items from a SOAP response.
 * The `Result` element holds XML-escaped DIDL-Lite, so it is unescaped and
 * then parsed as a document of its own.
 */
function parseDidl(resp) {
  const didl = xmlParser.parse(unescapeXml(resp.Result || ''))['DIDL-Lite'] || {};
  let containers = didl.container || [];
  let items = didl.item || [];
  if (!Array.isArray(containers)) containers = [containers];
  if (!Array.isArray(items)) items = [items];
  return {
    containers,
    items,
    returned: Number(resp.NumberReturned || 0),
    total: Number(resp.TotalMatches || 0),
  };
}

async function browse(baseUrl, objectID = '0', startingIndex = 0, requestedCount = 0) {
  const resp = await soap(baseUrl, 'Browse',
    `<ObjectID>${xmlEscape(objectID)}</ObjectID>` +
    '<BrowseFlag>BrowseDirectChildren</BrowseFlag>' +
    '<Filter>*</Filter>' +
    `<StartingIndex>${startingIndex}</StartingIndex>` +
    `<RequestedCount>${requestedCount}</RequestedCount>` +
    '<SortCriteria></SortCriteria>');
  return parseDidl(resp);
}

/** Whether the server supports UPnP Search at all (Gerbera 3.x does). */
async function supportsSearch(baseUrl) {
  if (cachedSearchSupported !== null) return cachedSearchSupported;
  try {
    const resp = await soap(baseUrl, 'GetSearchCapabilities', '');
    cachedSearchSupported = String(resp.SearchCaps || '').includes('upnp:class');
  } catch {
    cachedSearchSupported = false;
  }
  return cachedSearchSupported;
}

async function search(baseUrl, criteria, startingIndex = 0, requestedCount = 0) {
  const resp = await soap(baseUrl, 'Search',
    '<ContainerID>0</ContainerID>' +
    `<SearchCriteria>${xmlEscape(criteria)}</SearchCriteria>` +
    '<Filter>*</Filter>' +
    `<StartingIndex>${startingIndex}</StartingIndex>` +
    `<RequestedCount>${requestedCount}</RequestedCount>` +
    '<SortCriteria></SortCriteria>');
  return parseDidl(resp);
}

/** Flattens a DIDL <item> into a plain object with a stream URL and a thumbnail. */
function toVideo(item) {
  let resources = item.res || [];
  if (!Array.isArray(resources)) resources = [resources];

  const value = r => (typeof r === 'string' ? r : r && r['#text']);
  const proto = r => String((typeof r === 'object' && r && r['@_protocolInfo']) || '');

  const video = resources.find(r => proto(r).includes(':video/')) || resources[0];
  if (!video) return null;

  const url = value(video);
  if (!url) return null;

  const thumbRes = resources.find(r => proto(r).includes(':image/'));
  const art = item['upnp:albumArtURI'];
  const thumb = (thumbRes && value(thumbRes)) ||
    (typeof art === 'string' ? art : art && art['#text']) || null;

  const attr = k => (typeof video === 'object' ? video[k] : undefined);
  const mime = (proto(video).split(':')[2] || '').trim() || null;

  return {
    objectId: String(item['@_id']),
    rawTitle: String(item['dc:title'] || 'Untitled'),
    url,
    thumb,
    mime,
    size: attr('@_size') ? Number(attr('@_size')) : null,
    duration: attr('@_duration') || null,
    resolution: attr('@_resolution') || null,
    bitrate: attr('@_bitrate') ? Number(attr('@_bitrate')) : null,
  };
}

/** Fallback path: walk the whole tree when UPnP Search is unavailable. */
async function crawlVideos(baseUrl, objectID = '0', depth = 0, maxDepth = 8, acc = []) {
  if (depth > maxDepth) return acc;

  let page;
  try {
    page = await browse(baseUrl, objectID);
  } catch (err) {
    // One awkward folder should not abort the whole scan, but a failure at the
    // root means the library could not be read at all — let that propagate.
    if (depth === 0) throw err;
    console.warn(`Skipping objectID=${objectID} (browse failed): ${err.message}`);
    return acc;
  }

  for (const item of page.items) {
    if (!String(item['upnp:class'] || '').includes('videoItem')) continue;
    const v = toVideo(item);
    if (v) acc.push(v);
  }

  for (const container of page.containers) {
    const childId = container['@_id'];
    if (childId === undefined) continue;
    // Dynamic folders (Recently Added/Modified) only mirror existing files.
    if (String(container['upnp:class'] || '').includes('dynamicFolder')) continue;
    await crawlVideos(baseUrl, String(childId), depth + 1, maxDepth, acc);
  }
  return acc;
}

/**
 * Returns every video file on the server, deduplicated.
 *
 * Gerbera exposes the same file in several places at once (PC Directory plus
 * the virtual Video/All Video/Directories tree), so each file shows up two or
 * more times under different object IDs. Entries are merged by title, size
 * and duration.
 */
async function getAllVideos(baseUrl) {
  // Resolve the control URL up front. Both paths below tolerate per-request
  // failures, so without this an unreachable server would quietly look like an
  // empty library instead of reporting an error.
  await getControlUrl(baseUrl);

  let raw = [];

  if (await supportsSearch(baseUrl)) {
    const criteria = 'upnp:class derivedfrom "object.item.videoItem"';
    const PAGE = 500;
    let start = 0;
    for (;;) {
      const page = await search(baseUrl, criteria, start, PAGE);
      for (const item of page.items) {
        const v = toVideo(item);
        if (v) raw.push(v);
      }
      if (page.returned === 0) break;
      start += page.returned;
      if (start >= page.total) break;
    }
  } else {
    console.warn('Server does not support UPnP Search — falling back to a slower tree walk.');
    raw = await crawlVideos(baseUrl);
  }

  const byFile = new Map();
  for (const v of raw) {
    const key = `${v.rawTitle}|${v.size || 0}|${v.duration || ''}`;
    const existing = byFile.get(key);
    // Prefer the copy that carries a thumbnail
    if (!existing || (!existing.thumb && v.thumb)) byFile.set(key, v);
  }
  return [...byFile.values()];
}

module.exports = { getAllVideos, browse, search, supportsSearch, toVideo };
