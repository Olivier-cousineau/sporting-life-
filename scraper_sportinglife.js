const fs = require('fs/promises');
const path = require('path');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.sportinglife.ca/en-CA/clearance/?page=';
const SOURCE = 'sportinglife-clearance';
const REQUEST_TIMEOUT_MS = 15000;
const PAGE_DELAY_MS = 300;
const MAX_RETRIES = 2;

const SHARD_INDEX = parseInt(process.env.SHARD_INDEX || '1', 10);
const TOTAL_SHARDS = parseInt(process.env.TOTAL_SHARDS || '1', 10);
const MAX_PAGES = parseInt(process.env.MAX_PAGES || '50', 10);
const SAVE_DEBUG_HTML = process.env.SAVE_DEBUG_HTML === 'true';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePrice(value) {
  if (!value) return null;
  const cleaned = value.replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  const asNumber = parseFloat(cleaned);
  return Number.isFinite(asNumber) ? asNumber : null;
}

function buildAbsoluteLink(href) {
  try {
    return new URL(href, 'https://www.sportinglife.ca').toString();
  } catch (error) {
    return href || '';
  }
}

function extractProductsFromNodes($, nodes) {
  const products = [];
  nodes.each((_, node) => {
    const $node = $(node);
    const name = $node.find('.product-name a, .product-name, .product-card__name, .product-tile__name, .pdp-link').first().text().trim();
    const brand = $node.find('.product-brand, .brand, .product-tile__brand, .product-card__brand').first().text().trim();

    const priceText =
      $node.find('.product-sales-price, .price-sales .value, .sales .value, .product-price__value, .product-price .price-sales')
        .first()
        .text()
        .trim() ||
      $node.attr('data-price');
    const originalPriceText =
      $node.find('.product-standard-price .value, .strike-through .value, .product-price .price-standard, .product-price__was')
        .first()
        .text()
        .trim();

    const price = parsePrice(priceText);
    const originalPrice = parsePrice(originalPriceText);
    const discount = price && originalPrice && originalPrice > price ? Math.round(((originalPrice - price) / originalPrice) * 100) : null;

    const image =
      $node.find('img').first().attr('data-src') ||
      $node.find('img').first().attr('src') ||
      $node.find('img').first().attr('data-original') ||
      '';

    const link = buildAbsoluteLink(
      $node.find('a').first().attr('href') ||
        $node.find('.pdp-link').first().attr('href') ||
        $node.attr('data-pdp-url') ||
        ''
    );

    if (!link && !name) {
      return;
    }

    products.push({ name: name || link, brand: brand || null, price, originalPrice, discount, image, link });
  });
  return products;
}

function extractFallbackProducts($) {
  const products = [];
  const anchors = new Set();
  $('a[href*="/p/"]').each((_, a) => {
    const href = $(a).attr('href');
    const absolute = buildAbsoluteLink(href);
    if (!href || anchors.has(absolute)) return;
    anchors.add(absolute);
    const name = $(a).text().trim();
    products.push({ name: name || absolute, brand: null, price: null, originalPrice: null, discount: null, image: null, link: absolute });
  });
  return products;
}

function parseProducts(html) {
  const $ = cheerio.load(html);
  const productNodes = $('.product-tile, .product-grid__item, article.product, li.grid-tile, .product-card');
  let products = extractProductsFromNodes($, productNodes);

  if (!products.length) {
    products = extractFallbackProducts($);
  }

  const deduped = new Map();
  for (const product of products) {
    if (!product.link) continue;
    if (!deduped.has(product.link)) {
      deduped.set(product.link, product);
    }
  }
  return Array.from(deduped.values());
}

async function fetchWithRetry(url, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; sportinglife-clearance-bot/1.0)' } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    if (attempt < MAX_RETRIES) {
      console.warn(`Retrying ${url} (attempt ${attempt + 1}) due to error: ${error.message}`);
      await delay(500);
      return fetchWithRetry(url, attempt + 1);
    }
    console.error(`Failed to fetch ${url}: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function splitEvenly(items, totalShards) {
  if (totalShards <= 0) return [items];
  const baseSize = Math.floor(items.length / totalShards);
  const remainder = items.length % totalShards;
  const result = [];
  let start = 0;
  for (let i = 0; i < totalShards; i++) {
    const size = baseSize + (i < remainder ? 1 : 0);
    const slice = items.slice(start, start + size);
    result.push(slice);
    start += size;
  }
  return result;
}

function getShardStores(stores, shardIndex, totalShards) {
  const shards = splitEvenly(stores, totalShards);
  return shards[shardIndex - 1] || [];
}

async function loadStores() {
  const storePath = path.join(__dirname, 'data', 'sportinglife_stores.json');
  const raw = await fs.readFile(storePath, 'utf8');
  return JSON.parse(raw);
}

async function saveDebugHtml(html) {
  const debugPath = path.join(__dirname, 'outputs', 'debug', 'sportinglife_page1.html');
  await fs.mkdir(path.dirname(debugPath), { recursive: true });
  await fs.writeFile(debugPath, html, 'utf8');
  console.log(`Saved debug HTML to ${debugPath}`);
}

async function scrapeClearance() {
  const stores = await loadStores();
  if (!Array.isArray(stores) || !stores.length) {
    throw new Error('No stores configured');
  }

  const shardStores = getShardStores(stores, SHARD_INDEX, TOTAL_SHARDS);
  console.log(`Total stores: ${stores.length}. Shard ${SHARD_INDEX}/${TOTAL_SHARDS} handles ${shardStores.length} stores.`);

  const productMap = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE_URL}${page}`;
    console.log(`Fetching page ${page}: ${url}`);
    const html = await fetchWithRetry(url);
    if (!html) {
      console.warn(`Stopping pagination due to fetch failure on page ${page}.`);
      break;
    }

    const products = parseProducts(html);
    if (!products.length) {
      console.warn(`No products found on page ${page}.`);
      if (page === 1 && SAVE_DEBUG_HTML) {
        await saveDebugHtml(html);
      }
      break;
    }

    for (const product of products) {
      if (!product.link) continue;
      if (!productMap.has(product.link)) {
        productMap.set(product.link, product);
      }
    }

    await delay(PAGE_DELAY_MS);
  }

  const products = Array.from(productMap.values());
  const updatedAt = new Date().toISOString();
  await fs.mkdir(path.join(__dirname, 'public', 'sportinglife'), { recursive: true });

  for (const store of shardStores) {
    const output = {
      store,
      updatedAt,
      source: SOURCE,
      products
    };
    const filePath = path.join(__dirname, 'public', 'sportinglife', `${store.storeKey}.json`);
    await fs.writeFile(filePath, JSON.stringify(output, null, 2));
    console.log(`Wrote ${products.length} products for store ${store.storeKey} to ${filePath}`);
  }

  const indexPath = path.join(__dirname, 'public', 'sportinglife', 'products-index.json');
  const indexData = {
    updatedAt,
    source: SOURCE,
    products
  };
  await fs.writeFile(indexPath, JSON.stringify(indexData, null, 2));
  console.log(`Wrote product index with ${products.length} products to ${indexPath}`);
}

scrapeClearance()
  .then(() => console.log('Scraping complete'))
  .catch((error) => {
    console.error('Scraper failed', error);
    process.exitCode = 1;
  });
