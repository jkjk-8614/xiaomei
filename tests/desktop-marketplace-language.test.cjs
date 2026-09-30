const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = readFileSync(path.join(__dirname, '../desktop/main.cjs'), 'utf8');
const extractFunction = (name) => {
  const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `Missing function: ${name}`);
  return match[0];
};

const marketplaceHosts = {
  amazon: ['amazon.com', 'amazon.cn', 'amazon.co.uk'],
  tiktok: ['tiktok.com', 'tiktokshop.com'],
  temu: ['temu.com', 'temu.de'],
  shopee: ['shopee.com', 'shopee.sg'],
  ozon: ['ozon.ru', 'ozon.com'],
  ebay: ['ebay.com', 'ebay.de'],
  aliexpress: ['aliexpress.com', 'aliexpress.ru'],
  shein: ['shein.com', 'shein.de'],
};
const languageProfiles = {
  amazon: { label: '亚马逊', query: { language: 'zh_CN' } },
  tiktok: { label: 'TikTok Shop', query: { lang: 'zh-Hans' } },
  temu: { label: 'Temu', query: { language: 'zh' } },
  shopee: { label: '虾皮 Shopee', query: { language: 'zh-Hans' } },
  ozon: { label: 'Ozon', query: { language: 'zh' } },
  ebay: { label: 'eBay', query: { locale: 'zh-CN' } },
  aliexpress: { label: '速卖通', query: { lang: 'zh_CN' } },
  shein: { label: 'SHEIN', query: { language: 'zh' } },
};

function setup() {
  const context = vm.createContext({
    URL,
    NAVIGATION_HOST_FAMILIES: marketplaceHosts,
    MARKETPLACE_LANGUAGE_PROFILES: languageProfiles,
  });
  vm.runInContext([
    extractFunction('navigationHostFamily'),
    extractFunction('marketplaceLanguageProfile'),
    extractFunction('preferAmazonChineseUrl'),
    extractFunction('marketplaceLanguageLooksChinese'),
  ].join('\n'), context);
  return context;
}

test('all eight cross-border platform entries request native Chinese parameters', () => {
  const app = setup();
  const cases = [
    ['amazon', 'https://www.amazon.com/', 'language', 'zh_CN'],
    ['tiktok', 'https://shop.tiktok.com/', 'lang', 'zh-Hans'],
    ['temu', 'https://www.temu.com/', 'language', 'zh'],
    ['shopee', 'https://shopee.com/', 'language', 'zh-Hans'],
    ['ozon', 'https://www.ozon.ru/', 'language', 'zh'],
    ['ebay', 'https://www.ebay.com/', 'locale', 'zh-CN'],
    ['aliexpress', 'https://www.aliexpress.com/', 'lang', 'zh_CN'],
    ['shein', 'https://www.shein.com/', 'language', 'zh'],
  ];
  for (const [family, url, key, expected] of cases) {
    assert.equal(app.marketplaceLanguageProfile(url).family, family);
    assert.equal(new URL(app.preferAmazonChineseUrl(url)).searchParams.get(key), expected, family);
  }
});

test('an explicit non-Chinese native parameter is corrected, while domestic URLs stay unchanged', () => {
  const app = setup();
  assert.equal(new URL(app.preferAmazonChineseUrl('https://www.amazon.com/?language=en_US')).searchParams.get('language'), 'zh_CN');
  assert.equal(app.preferAmazonChineseUrl('https://www.taobao.com/'), 'https://www.taobao.com/');
});

test('visible language inspection accepts native Chinese and rejects foreign-only content', () => {
  const app = setup();
  assert.equal(app.marketplaceLanguageLooksChinese({ languageTag: 'zh-CN', chineseChars: 0, foreignChars: 80 }), true);
  assert.equal(app.marketplaceLanguageLooksChinese({ languageTag: 'en-US', chineseChars: 5, foreignChars: 120 }), false);
  assert.equal(app.marketplaceLanguageLooksChinese({ languageTag: 'en-US', chineseChars: 36, foreignChars: 40 }), true);
});

test('the in-page language checker is valid JavaScript before Electron executes it', () => {
  const match = source.match(/const PAGE_LANGUAGE_CHECK_SCRIPT = String\.raw`([\s\S]*?)`;/);
  assert.ok(match, 'Missing PAGE_LANGUAGE_CHECK_SCRIPT');
  assert.doesNotThrow(() => new Function(match[1]));
});
