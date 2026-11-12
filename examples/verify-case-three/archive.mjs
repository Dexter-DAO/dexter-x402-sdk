#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function publicHttps(value) {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || host === 'localhost' || host.endsWith('.localhost')
    || host === '::1' || /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error('Public HTTPS URL required');
  }
  return url;
}

/** Node fetch decodes HTTP Content-Encoding, including gzip, deflate and br, before arrayBuffer(). */
export async function fetchPublicBytes(value, {fetcher = fetch, limit = 2_000_000, redirects = 4} = {}) {
  let url = publicHttps(value);
  for (let i = 0; i <= redirects; i++) {
    const response = await fetcher(url.href, {redirect: 'manual', signal: AbortSignal.timeout(20_000),
      headers: {'accept': '*/*', 'accept-encoding': 'gzip, deflate, br'}});
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Redirect has no location');
      url = publicHttps(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.origin}`);
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    if (reader) {
      try {
        for (;;) {
          const {value: chunk, done} = await reader.read();
          if (done) break;
          size += chunk.length;
          if (size > limit) throw new Error('Response exceeds byte limit');
          chunks.push(chunk);
        }
      } finally { await reader.cancel(); }
    }
    return {bytes: Buffer.concat(chunks), url: url.href, headers: response.headers};
  }
  throw new Error('Too many redirects');
}

export function archiveRawUrl(value) {
  const url = publicHttps(value);
  if (url.hostname !== 'web.archive.org') throw new Error('Expected a Wayback snapshot');
  const match = /^\/web\/(\d{14})(?:id_)?\/(https:\/\/.+)$/.exec(url.pathname + url.search);
  if (!match) throw new Error('Expected a timestamped HTTPS Wayback snapshot');
  publicHttps(match[2]);
  return `https://web.archive.org/web/${match[1]}id_/${match[2]}`;
}

export async function saveArchive(value, options = {}) {
  const source = publicHttps(value).href;
  const live = await fetchPublicBytes(source, {...options, limit: 65_536});
  const saved = await fetchPublicBytes(`https://web.archive.org/save/${source}`, {...options, limit: 2_000_000});
  const location = saved.headers.get('content-location') ?? saved.url;
  const raw = archiveRawUrl(new URL(location, 'https://web.archive.org').href);
  const snapshot = await fetchPublicBytes(raw, {...options, limit: 65_536});
  return {timestamp: /\/web\/(\d{14})/.exec(raw)[1], url: raw, liveSha256: sha256(live.bytes),
    archiveSha256: sha256(snapshot.bytes), matched: live.bytes.equals(snapshot.bytes)};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node archive.mjs <https-url>');
    const result = await saveArchive(process.argv[2]);
    console.log(JSON.stringify(result, null, 2));
    if (!result.matched) process.exitCode = 1;
  } catch (error) { console.error(`FAIL archive: ${error.message}`); process.exitCode = 1; }
}
