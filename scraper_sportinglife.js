const fs = require('fs/promises');
const path = require('path');
const { chromium } = require('playwright');

const CLEARANCE_URL = 'https://www.sportinglife.ca/en-CA/clearance/';
const SOURCE = 'sportinglife-clearance';
const PRODUCT_TILE_SELECTOR = '.product-tile, .product-grid__item, article.product, li.grid-tile, .product-card';
function parseLimit(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const MAX_CLICKS = parseLimit(process.env.MAX_CLICKS || '40', 40);
const MAX_ITEMS = parseLimit(process.env.MAX_ITEMS || '3000', 3000);

const SHARD_INDEX = parseInt(process.env.SHARD_INDEX || '1', 10);
const TOTAL_SHARDS = parseInt(process.env.TOTAL_SHARDS || '1', 10);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function saveDebugArtifacts(page) {
  try {
    const html = await page.content();
    const debugHtmlPath = path.join(__dirname, 'outputs', 'debug', 'sportinglife_page.html');
    await fs.mkdir(path.dirname(debugHtmlPath), { recursive: true });
    await fs.writeFile(debugHtmlPath, html, 'utf8');
    console.log(`Saved debug HTML to ${debugHtmlPath}`);
  } catch (error) {
    console.warn('Failed to save debug HTML', error);
  }

  try {
    const screenshotPath = path.join(__dirname, 'outputs', 'debug', 'sportinglife.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Saved debug screenshot to ${screenshotPath}`);
  } catch (error) {
    console.warn('Failed to save debug screenshot', error);
  }
}

async function acceptCookiesIfPresent(page) {
  const cookieButtons = page.locator(
    'button:has-text("Accept"), button:has-text("Accepter"), button:has-text("J\'accepte"), a:has-text("Accept"), a:has-text("Accepter")'
  );
  if ((await cookieButtons.count()) > 0) {
    try {
      await cookieButtons.first().click({ timeout: 5000 });
      await delay(500);
      console.log('Accepted cookie banner');
    } catch (error) {
      console.warn('Cookie banner click failed or not present.', error.message);
    }
  }
}

async function findShowMoreButton(page) {
  const locator = page.locator(
    'button:has-text("Show more"), button:has-text("Show More"), button:has-text("Voir plus"), button:has-text("Voir Plus"), ' +
      'a:has-text("Show more"), a:has-text("Show More"), a:has-text("Voir plus"), a:has-text("Voir Plus")'
  );
  const count = await locator.count();
  for (let i = 0; i < count; i++) {
    const button = locator.nth(i);
    if (await button.isVisible()) {
      return button;
    }
  }
  return null;
}

async function extractProducts(page) {
  return page.evaluate((selector) => {
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

    const nodes = Array.from(document.querySelectorAll(selector));
    return nodes
      .map((node) => {
        const name =
          node.querySelector('.product-name a, .product-name, .product-card__name, .product-tile__name, .pdp-link')?.textContent.trim() || '';
        const brand = node.querySelector('.product-brand, .brand, .product-tile__brand, .product-card__brand')?.textContent.trim() || null;

        const priceText =
          node.querySelector('.product-sales-price, .price-sales .value, .sales .value, .product-price__value, .product-price .price-sales')
            ?.textContent.trim() || node.getAttribute('data-price');
        const originalPriceText =
          node.querySelector('.product-standard-price .value, .strike-through .value, .product-price .price-standard, .product-price__was')
            ?.textContent.trim() || null;

        const image =
          node.querySelector('img')?.getAttribute('data-src') ||
          node.querySelector('img')?.getAttribute('src') ||
          node.querySelector('img')?.getAttribute('data-original') ||
          '';

        const link = buildAbsoluteLink(
          node.querySelector('a')?.getAttribute('href') ||
            node.querySelector('.pdp-link')?.getAttribute('href') ||
            node.getAttribute('data-pdp-url') ||
            ''
        );

        if (!link && !name) {
          return null;
        }

        const price = parsePrice(priceText);
        const originalPrice = parsePrice(originalPriceText);
        const discount =
          price !== null && originalPrice !== null && originalPrice > price
            ? Math.round(((originalPrice - price) / originalPrice) * 100)
            : null;

        return {
          name: name || link,
          brand,
          price,
          originalPrice,
          discount,
          image,
          link
        };
      })
      .filter(Boolean);
  }, PRODUCT_TILE_SELECTOR);
}

async function collectProducts(page, productMap) {
  const products = await extractProducts(page);
  let added = 0;
  for (const product of products) {
    if (!product.link) continue;
    if (!productMap.has(product.link)) {
      productMap.set(product.link, product);
      added += 1;
    }
  }
  return added;
}

async function clickAndWaitForGrowth(page, button, previousCount) {
  await Promise.all([button.click({ timeout: 10000 }), page.waitForTimeout(300)]);
  const increased = await page
    .waitForFunction(
      (prev, selector) => {
        return document.querySelectorAll(selector).length > prev;
      },
      previousCount,
      PRODUCT_TILE_SELECTOR,
      { timeout: 10000 }
    )
    .then(() => true)
    .catch(() => false);

  if (!increased) {
    await page.waitForTimeout(1000);
  }

  return increased;
}

async function loadAllProducts(page) {
  const productMap = new Map();
  let stagnantAttempts = 0;
  let clickCount = 0;

  await page.waitForSelector(PRODUCT_TILE_SELECTOR, { timeout: 20000 });
  await collectProducts(page, productMap);

  while (true) {
    if (productMap.size >= MAX_ITEMS) {
      console.log(`Reached MAX_ITEMS limit (${MAX_ITEMS}). Stopping pagination.`);
      break;
    }

    const button = await findShowMoreButton(page);
    if (!button) {
      console.log('No more "Show more" button found. Stopping pagination.');
      break;
    }

    if (clickCount >= MAX_CLICKS) {
      console.log(`Reached MAX_CLICKS limit (${MAX_CLICKS}). Stopping pagination.`);
      break;
    }

    const beforeCount = productMap.size;
    console.log(`Clicking "Show more" button (click ${clickCount + 1}/${MAX_CLICKS}). Current products: ${beforeCount}.`);
    await clickAndWaitForGrowth(page, button, beforeCount);
    clickCount += 1;

    const added = await collectProducts(page, productMap);
    if (added === 0 && productMap.size === beforeCount) {
      stagnantAttempts += 1;
      console.log(`No new products after click. Stagnant attempts: ${stagnantAttempts}/2.`);
      if (stagnantAttempts >= 2) {
        console.log('Stopping pagination after two attempts without growth.');
        break;
      }
    } else {
      stagnantAttempts = 0;
    }
  }

  return Array.from(productMap.values()).slice(0, MAX_ITEMS);
}

async function saveOutputs(products, shardStores) {
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

async function scrapeClearance() {
  const stores = await loadStores();
  if (!Array.isArray(stores) || !stores.length) {
    throw new Error('No stores configured');
  }

  const shardStores = getShardStores(stores, SHARD_INDEX, TOTAL_SHARDS);
  console.log(`Total stores: ${stores.length}. Shard ${SHARD_INDEX}/${TOTAL_SHARDS} handles ${shardStores.length} stores.`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    await page.goto(CLEARANCE_URL, { waitUntil: 'networkidle' });
    await acceptCookiesIfPresent(page);
    const products = await loadAllProducts(page);
    await saveOutputs(products, shardStores);
  } catch (error) {
    console.error('Scraper encountered an error:', error);
    await saveDebugArtifacts(page);
    throw error;
  } finally {
    await browser.close();
  }
}

scrapeClearance()
  .then(() => console.log('Scraping complete'))
  .catch((error) => {
    console.error('Scraper failed', error);
    process.exitCode = 1;
  });
