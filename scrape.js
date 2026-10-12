import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { load } from 'cheerio';

const SHOP_URL = 'https://anikoto.net/community/shop';
// Always save alongside this script, even when launched from another directory.
const OUTPUT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'anikoto_data.json');
const REQUEST_TIMEOUT_MS = 45_000;
const REQUEST_DELAY_MS = 1_000;
const MAX_ATTEMPTS = 4;
const MAX_PAGES = 500;
const KINDS = [
  { value: 'deco', label: 'Decorations', itemType: 'decoration' },
  { value: 'title', label: 'Titles', itemType: 'title' },
];

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function retryDelay(header, attempt) {
  const seconds = Number(header);
  const date = Date.parse(header ?? '');
  const requested = header && Number.isFinite(seconds)
    ? seconds * 1_000
    : Number.isFinite(date) ? date - Date.now() : 0;
  return Math.min(120_000, Math.max(2_000 * 2 ** (attempt - 1), requested));
}

async function fetchPage(url) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let delay = retryDelay(null, attempt);
    let retryable = true;
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'AnikotoShopScraper/1.0 (public shop catalog)',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        retryable = [408, 425, 429].includes(response.status) || response.status >= 500;
        delay = retryDelay(response.headers.get('retry-after'), attempt);
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const finalUrl = new URL(response.url);
      if (finalUrl.origin !== new URL(SHOP_URL).origin || finalUrl.pathname !== '/community/shop') {
        retryable = false;
        await response.body?.cancel();
        throw new Error(`Unexpected redirect to ${response.url}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        retryable = false;
        await response.body?.cancel();
        throw new Error(`Expected shop HTML, received ${contentType || 'an unknown content type'}`);
      }
      return await response.text();
    } catch (error) {
      if (!retryable || attempt === MAX_ATTEMPTS) {
        throw new Error(`Unable to fetch ${url}: ${error.message}`, { cause: error });
      }
      console.warn(`Request failed (${error.message}); retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay / 1_000}s.`);
      await sleep(delay);
    }
  }
}

function parsePrice(value, name) {
  const digits = clean(value).replace(/\s*mana\s*$/i, '').replace(/[,\s]/g, '');
  if (!/^\d+$/.test(digits) || !Number.isSafeInteger(Number(digits))) {
    throw new Error(`Invalid Mana price for "${name}": ${JSON.stringify(value)}`);
  }
  return Number(digits);
}

function imageUrl(card, pageUrl) {
  // The primary shop asset is preferred over Discord's PNG preview and the
  // sample user's JPEG avatar. Some APNG assets use a .png extension.
  const candidates = [
    card.attr('data-url'),
    card.find('img.deco').attr('data-src'),
    card.find('img.deco').attr('src'),
    card.attr('data-preview-url'),
  ];
  const urls = [];
  for (const candidate of candidates) {
    if (!clean(candidate)) continue;
    try {
      const url = new URL(clean(candidate), pageUrl);
      if (['http:', 'https:'].includes(url.protocol)) urls.push(url);
    } catch {
      // Try the next real image source if one attribute is malformed.
    }
  }
  const image = urls.find(url => /\.(webp|apng|gif)$/i.test(url.pathname))
    ?? urls.find(url => /\.png$/i.test(url.pathname));
  return image?.href ?? null;
}

function parsePage(html, pageUrl, kind, requestedPage) {
  const $ = load(html);
  const grid = $('#shop-grid');
  if (grid.length !== 1 || $('.shop-layout').attr('data-kind') !== kind.value) {
    throw new Error(`Shop markup missing or wrong item tab at ${pageUrl}. The site may have changed or returned a login/challenge page.`);
  }

  const summary = clean(grid.closest('.my-zone-card').find('h3 .sub').first().text());
  const pagination = summary.match(/^([\d,]+)\s*·\s*page\s+(\d+)\s*\/\s*(\d+)$/i);
  if (!pagination) {
    throw new Error(`Cannot read catalog pagination at ${pageUrl}: ${JSON.stringify(summary)}`);
  }
  const total = Number(pagination[1].replace(/,/g, ''));
  const currentPage = Number(pagination[2]);
  const totalPages = Number(pagination[3]);
  if (!Number.isSafeInteger(total) || totalPages < 1 || totalPages > MAX_PAGES
      || currentPage !== requestedPage || currentPage > totalPages) {
    throw new Error(`Invalid or repeated shop page at ${pageUrl}: ${summary}`);
  }

  const items = grid.find('.shop-card').toArray().map(element => {
    const card = $(element);
    const id = clean(card.attr('data-id'));
    const itemName = clean(card.attr('data-name')) || clean(card.find('.sc-name').text());
    const category = clean(card.attr('data-cat')) || clean(card.find('.sc-cat-name').text());
    if (!id || !itemName || !category || card.attr('data-kind') !== kind.value) {
      throw new Error(`Incomplete or unexpected item ${id || '(no ID)'} at ${pageUrl}`);
    }

    const animatedImageUrl = imageUrl(card, pageUrl);
    if (kind.value === 'deco' && !animatedImageUrl) {
      throw new Error(`No WebP/APNG/GIF image URL found for decoration "${itemName}" at ${pageUrl}`);
    }

    return {
      id,
      item_type: kind.itemType,
      item_name: itemName,
      category,
      price_mana: parsePrice(card.attr('data-price') || card.find('.sc-price').text(), itemName),
      // Titles are text/icon badges on Anikoto and currently have no image URL.
      animated_image_url: animatedImageUrl,
    };
  });
  if (total > 0 && items.length === 0) {
    throw new Error(`Shop page contains no items despite a catalog total of ${total}: ${pageUrl}`);
  }
  return { items, total, totalPages };
}

async function scrapeKind(kind) {
  const items = new Map();
  let expectedTotal;
  let totalPages = 1;

  for (let page = 1; page <= totalPages; page += 1) {
    const url = new URL(SHOP_URL);
    url.searchParams.set('tab', 'shop');
    url.searchParams.set('kind', kind.value);
    url.searchParams.set('page', String(page));

    const parsed = parsePage(await fetchPage(url.href), url.href, kind, page);
    if (page === 1) {
      expectedTotal = parsed.total;
      totalPages = parsed.totalPages;
    } else if (parsed.total !== expectedTotal || parsed.totalPages !== totalPages) {
      throw new Error(`${kind.label} catalog changed during scraping. Run again for a consistent result.`);
    }

    for (const item of parsed.items) {
      if (items.has(item.id)) {
        throw new Error(`Repeated ${kind.label} item ID ${item.id} on page ${page}. Run again; pagination may have shifted.`);
      }
      items.set(item.id, item);
    }
    console.log(`${kind.label}: page ${page}/${totalPages}, ${items.size}/${expectedTotal} items`);
    if (page < totalPages) await sleep(REQUEST_DELAY_MS);
  }

  if (items.size !== expectedTotal) {
    throw new Error(`Incomplete ${kind.label} catalog: expected ${expectedTotal}, collected ${items.size}.`);
  }
  return [...items.values()];
}

async function saveData(items) {
  const temporaryPath = `${OUTPUT_PATH}.${process.pid}.${Date.now()}.tmp`;
  // Replace the output only after both complete catalogs have been validated.
  // Any fetch/parse failure leaves the previous successful JSON untouched.
  try {
    await writeFile(temporaryPath, `${JSON.stringify(items, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, OUTPUT_PATH);
  } finally {
    await unlink(temporaryPath).catch(error => {
      if (error.code !== 'ENOENT') console.warn(`Could not remove temporary output: ${error.message}`);
    });
  }
}

async function main() {
  const items = [];
  for (const [index, kind] of KINDS.entries()) {
    if (index > 0) await sleep(REQUEST_DELAY_MS);
    items.push(...await scrapeKind(kind));
  }
  if (items.length === 0) throw new Error('The shop returned no items; no output was written.');
  await saveData(items);
  console.log(`Saved ${items.length} items to ${OUTPUT_PATH}`);
  console.log('Title badges without an image are included with animated_image_url: null.');
}

main().catch(error => {
  console.error(`Scraping failed: ${error.message}`);
  process.exitCode = 1;
});
