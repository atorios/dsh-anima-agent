/**
 * Bundled NovelAI style catalogue (quicktagcloud `artist_nai5_personal`).
 *
 * The index ships with the plugin; preview images are fetched from the CDN on
 * demand into a local cache. That keeps the package at ~1.6 MB instead of the
 * ~2.8 GB the full image set would take.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ComfyError } from './comfy.js';

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(PLUGIN_DIR, 'styles.json');
const CACHE_DIR = join(PLUGIN_DIR, 'style-cache');

let cached = null;

function loadIndex() {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  cached = {
    meta: raw,
    rows: raw.entries.map((row, index) => ({
      index: index + 1,
      tags: row[0],
      category: row[1],
      rating: row[2],
      image: row[3],
    })),
  };
  return cached;
}

/** Shorten a long prompt string for display without losing its artists. */
function summarise(tags, max = 220) {
  const text = String(tags).replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function styleCount() {
  return loadIndex().rows.length;
}

const WEIGHT_BLOCK = /(-?\d+(?:\.\d+)?)\s*::\s*([\s\S]*?)\s*::/g;

const ANIMA_QUALITY = 'masterpiece, best quality, score_7, safe';

const ANIMA_NEGATIVE =
  'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration';

/** Tags that only mean something to NovelAI; dropping them avoids noise. */
const DROP_TAGS = new Set([
  'artist collaboration',
  'artist_collaboration',
  'very aesthetic',
  'aesthetic',
  'masterpiece',
  'best quality',
  'amazing quality',
  'highres',
  'incredibly absurdres',
  'absurdres',
  'commission',
]);

/**
 * Unwrap NovelAI's `weight::text::` blocks. Negative weights become negative
 * prompt fragments instead of being silently dropped.
 */
function unwrapWeights(raw) {
  const negatives = [];
  let text = String(raw || '');
  for (let pass = 0; pass < 5; pass += 1) {
    const before = text;
    text = text.replace(WEIGHT_BLOCK, (_match, weight, inner) => {
      const value = Number(weight);
      if (Number.isFinite(value) && value < 0) {
        negatives.push(inner);
        return ' ';
      }
      return ` ${inner} `;
    });
    if (text === before) break;
  }
  return { text, negatives };
}

/** Words that ride along inside weight blocks but are not artist names. */
const NOT_ARTISTS = new Set([
  'nsfw',
  'safe',
  'questionable',
  'explicit',
  'artist collaboration',
  'very aesthetic',
  'masterpiece',
  'best quality',
  'amazing quality',
  'absurdres',
  'highres',
]);

function isArtistish(name) {
  const key = name.toLowerCase().trim();
  if (!key || NOT_ARTISTS.has(key)) return false;
  if (/^year \d{4}$/.test(key)) return false;
  if (/^-?\d/.test(key)) return false;
  return true;
}

/**
 * Some catalogue rows list artists without the `artist:` prefix, as bare
 * `1.39::name::` blocks. When a row has no explicit artist tag at all, treat
 * the wrapped block contents as artists.
 */
function inferArtists(raw) {
  const wrapped = [];
  let match;
  const scan = /(-?\d+(?:\.\d+)?)\s*::\s*([\s\S]*?)\s*::/g;
  while ((match = scan.exec(String(raw)))) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value < 0) continue;
    for (const part of match[2].split(',')) {
      const name = part.replace(/\\/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
      if (isArtistish(name) && !wrapped.some((seen) => seen.toLowerCase() === name.toLowerCase())) {
        wrapped.push(name);
      }
    }
  }
  return wrapped;
}

/** Pull `artist:name` tokens out, normalising them to Anima's `@name`. */
function extractArtists(text) {
  const artists = [];
  const rest = text.replace(/artist:\s*([^,]+)/gi, (_match, name) => {
    const clean = String(name)
      .replace(/\\/g, '')
      .replace(/::/g, ' ')
      .replace(/_/g, ' ')
      .replace(/[:;]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      // Parentheses disambiguate artist tags (`fuka (kantoku)`); escape them so
      // ComfyUI reads them literally instead of as a weight group.
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
    if (clean && !artists.some((seen) => seen.toLowerCase() === clean.toLowerCase())) {
      artists.push(clean);
    }
    return ' , ';
  });
  return { artists, rest };
}

function cleanTags(rest) {
  const seen = new Set();
  const tags = [];
  for (const part of String(rest).split(',')) {
    const tag = part
      .replace(/^[-+\s]+/, '')
      .replace(/[()[\]]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[:;]+$/, '')
      .trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (DROP_TAGS.has(key) || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

/**
 * Convert one catalogue prompt into a ready-to-use Anima prompt pair.
 * The NovelAI weight syntax and `artist:` prefix do not exist in Anima, so the
 * artists become `@name` and the weights are flattened away.
 */
export function toAnimaPrompt(raw) {
  const { text, negatives } = unwrapWeights(raw);
  const { artists: tagged, rest } = extractArtists(text);
  const artists = tagged.length > 0 ? tagged : inferArtists(raw);
  const artistKeys = new Set(artists.map((name) => name.toLowerCase().replace(/\\/g, '')));
  const tags = cleanTags(rest).filter((tag) => !artistKeys.has(tag.toLowerCase()));
  const negativeExtras = cleanTags(negatives.join(','));

  const positiveParts = [ANIMA_QUALITY];
  if (artists.length) positiveParts.push(artists.map((name) => `@${name}`).join(', '));
  if (tags.length) positiveParts.push(tags.join(', '));

  const negativeParts = [ANIMA_NEGATIVE];
  if (negativeExtras.length) negativeParts.push(negativeExtras.join(', '));

  return {
    artists,
    positive: positiveParts.join(', '),
    negative: negativeParts.join(', '),
  };
}

/** Stable, speakable identifier for one catalogue row: `ST-0213`. */
export function tagOf(index) {
  return `ST-${String(index).padStart(4, '0')}`;
}

/** Accept `ST-0213`, `st213`, `213`, `#213` or `tag 213`. */
function parseTag(input) {
  const match = String(input ?? '').match(/(\d{1,6})/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Resolve one style by its tag, returning the converted prompt pair. */
export function styleByTag(tag) {
  const { rows } = loadIndex();
  const ordinal = parseTag(tag);
  const row = ordinal === null ? null : rows.find((item) => item.index === ordinal);
  if (!row) {
    throw new ComfyError(`找不到 tag「${tag}」。格式是 ST-0001 到 ST-${String(rows.length).padStart(4, '0')}。`);
  }
  const anima = toAnimaPrompt(row.tags);
  return {
    tag: tagOf(row.index),
    index: row.index,
    category: row.category,
    rating: row.rating,
    positive: anima.positive,
    negative: anima.negative,
    artists: anima.artists,
    raw: row.tags,
  };
}

/** Structured search for the Settings tab, one page at a time. */
export function listStyles(query, limit = 12, offset = 0) {
  const { rows, meta } = loadIndex();
  const needle = String(query || '').toLowerCase().trim();
  const hits = needle ? rows.filter((row) => row.tags.toLowerCase().includes(needle)) : rows;
  const size = Math.max(1, Math.min(Number(limit) || 12, 60));
  const start = Math.max(0, Math.min(Number(offset) || 0, Math.max(0, hits.length - 1)));
  return {
    total: rows.length,
    matched: hits.length,
    offset: start,
    limit: size,
    title: meta.title,
    version: meta.version,
    entries: hits.slice(start, start + size).map((row) => ({
      index: row.index,
      tag: tagOf(row.index),
      category: row.category || '',
      rating: row.rating || '',
    })),
  };
}

/**
 * Search the catalogue by substring. Empty query returns the first `limit`
 * entries, so the model can browse without inventing a keyword.
 */
export function searchStyles(query, limit = 10) {
  const data = listStyles(query, limit);
  if (data.entries.length === 0) {
    return `没有匹配「${query}」的画风。目录共 ${data.total} 条。换个关键词，或用空 query 浏览。`;
  }
  const lines = [
    `${data.title} · 版本 ${data.version} · 共 ${data.total} 条，匹配 ${data.matched} 条：`,
  ];
  for (const entry of data.entries) {
    lines.push(`${entry.tag} [${entry.category || '-'} · ${entry.rating}]`);
  }
  lines.push('要取某条画风的完整提示词：comfyui{action:"styles", tag:"ST-0213"}；要参考图：comfyui{action:"styles", preview:213}。');
  return lines.join('\n');
}

/** Return one entry's cached image path, downloading it the first time. */
export async function ensureStyleImage(index, timeoutMs = 45000) {
  const { rows, meta } = loadIndex();
  const row = rows.find((item) => item.index === Number(index));
  if (!row) {
    throw new ComfyError(`没有第 ${index} 条，有效范围 1-${rows.length}`);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const target = join(CACHE_DIR, row.image);

  if (!existsSync(target)) {
    const url = `${meta.imageBase}${row.image}`;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer: 'https://novelai.quicktagcloud.com/',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new ComfyError(`预览图下载失败 HTTP ${response.status}`);
      writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (error instanceof ComfyError) throw error;
      throw new ComfyError(`预览图下载失败：${error?.message || error}`);
    }
  }
  return { path: target, row };
}

/** Download one entry's preview image and hand back the prompt pair for it. */
export async function previewStyle(index, timeoutMs = 45000) {
  const { path, row } = await ensureStyleImage(index, timeoutMs);
  const anima = toAnimaPrompt(row.tags);
  return [
    `序号 ${row.index} · ${row.category || '-'} · ${row.rating}`,
    `正向（Anima 可直接用）: ${anima.positive}`,
    `负向: ${anima.negative}`,
    `原始 NovelAI 串: ${row.tags}`,
    `本地预览图: ${path}`,
    '现在调用 present 把它显示给用户，并把上面的正向提示词贴出来。',
  ].join('\n');
}

