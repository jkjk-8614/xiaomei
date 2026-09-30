'use strict';

// 达笔淘系详情 Skill 的稳定协议：可见页面只负责触发模块，真实样本
// 一律来自对应 mtop 响应中的 rateList / questionList。这个文件不保存
// Cookie、请求头或原始响应，只输出可供分析台使用的最小结构化记录。

const DABI_ENDPOINTS = Object.freeze({
  reviews: /(?:^|[/?])mtop\.taobao\.rate\.detaillist\.get(?:[/?]|$)/i,
  questions: /(?:^|[/?])mtop\.taobao\.wdj\.list\.merge\.search(?:[/?]|$)/i,
  detail: /(?:^|[/?])mtop\.taobao\.detail\.getdesc(?:[/?]|$)/i,
});

function classifyDabiEndpoint(value) {
  const url = String(value || '');
  if (DABI_ENDPOINTS.reviews.test(url)) return 'reviews';
  if (DABI_ENDPOINTS.questions.test(url)) return 'questions';
  if (DABI_ENDPOINTS.detail.test(url)) return 'detail';
  return '';
}

function parseDabiResponseBody(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  // 淘宝有时返回 mtopjsonpXXX({...}) 或带少量前缀的 JSON。
  const start = text.search(/[\[{]/);
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

function unwrapDabiPayload(value, kind = '') {
  const expected = kind === 'reviews'
    ? (node) => Array.isArray(node?.rateList)
    : kind === 'questions'
      ? (node) => Array.isArray(node?.questionList)
      : kind === 'detail'
        ? (node) => Boolean(node?.components && typeof node.components === 'object')
        : (node) => Boolean(node?.rateList || node?.questionList || node?.components);
  const queue = [value];
  const seen = new Set();
  const wrapperKeys = ['data', 'result', 'response', 'model', 'payload', 'content'];
  while (queue.length) {
    let current = queue.shift();
    if (typeof current === 'string') current = parseDabiResponseBody(current);
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (expected(current)) return current;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 12)) queue.push(item);
      continue;
    }
    for (const key of wrapperKeys) {
      if (current[key] !== undefined && current[key] !== null) queue.push(current[key]);
    }
  }
  return {};
}

function cleanText(value, limit = 4000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function absoluteUrl(value, base = 'https://item.taobao.com/') {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return new URL(raw.startsWith('//') ? `https:${raw}` : raw, base).href;
  } catch {
    return '';
  }
}

function firstValue(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  return null;
}

function detailMediaFromHtml(html, add) {
  const source = String(html || '');
  const tagRe = /<(?:img|video|source)\b[^>]*>/gi;
  const attrRe = /(?:src|data-src|data-original|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
  for (const tag of source.match(tagRe) || []) {
    const match = tag.match(attrRe);
    if (match) add(match[1] || match[2] || match[3] || '');
  }
}

function parseDabiNetworkRecords(records = {}, options = {}) {
  const baseUrl = String(options.baseUrl || 'https://item.taobao.com/');
  // 商品页显示的评价/问大家数量可能远大于单个接口响应；不要把
  // 首屏响应页大小误当成最终样本上限。评价默认整理 200 条，问大家
  // 默认整理 2000 条，均可通过调用参数或环境变量提高到 5000。
  const configuredReviewSamples = Number(
    options.maxReviewSamples
    || process.env.XIAOMEI_DABI_MAX_REVIEW_SAMPLES
    || process.env.COMMERCE_ANALYSIS_MAX_REVIEW_SAMPLES,
  );
  const maxReviewSamples = Math.max(
    20,
    Math.min(5000, configuredReviewSamples || 200),
  );
  const configuredQuestionSamples = Number(
    options.maxQuestionSamples
    || process.env.XIAOMEI_DABI_MAX_QUESTION_SAMPLES
    || process.env.COMMERCE_ANALYSIS_MAX_QUESTION_SAMPLES,
  );
  const maxQuestionSamples = Math.max(
    50,
    Math.min(5000, configuredQuestionSamples || 2000),
  );
  const reviews = [];
  const questions = [];
  const detailImages = [];
  const detailTexts = [];
  const seenReview = new Set();
  const questionById = new Map();
  const seenDetail = new Set();
  let reviewTotal = '';
  let questionTotal = '';
  let reviewHasNext = null;
  let questionHasNext = null;

  const addDetail = (value) => {
    const url = absoluteUrl(value, baseUrl);
    if (!/^https?:/i.test(url) || seenDetail.has(url)) return;
    seenDetail.add(url);
    detailImages.push(url);
  };
  const bounded = (value, limit) => cleanText(value, limit);
  const recordsFor = (kind) => Array.isArray(records?.[kind]) ? records[kind] : [];

  for (const record of recordsFor('reviews')) {
    const payload = unwrapDabiPayload(record?.data, 'reviews');
    const list = Array.isArray(payload.rateList) ? payload.rateList : [];
    reviewTotal = reviewTotal || cleanText(firstValue(payload, ['totalCount', 'rateCount', 'total', 'count', 'totalNum']), 80);
    const next = booleanValue(payload.hasNext);
    if (next !== null) reviewHasNext = next;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const content = bounded(firstValue(raw, ['feedback', 'rateContent', 'content', 'text']), 1800);
      const id = bounded(firstValue(raw, ['id', 'rateId']) || `${content}:${firstValue(raw, ['feedbackDate', 'gmtCreate'])}`, 160);
      if (!content || !id || seenReview.has(id)) continue;
      seenReview.add(id);
      const imageValues = Array.isArray(raw.feedPicPathList) ? raw.feedPicPathList : [];
      const videoValues = [
        ...(Array.isArray(raw.feedVideoPathList) ? raw.feedVideoPathList : []),
        ...(Array.isArray(raw.video?.cloudVideoUrl) ? raw.video.cloudVideoUrl : raw.video?.cloudVideoUrl ? [raw.video.cloudVideoUrl] : []),
      ];
      reviews.push({
        id,
        content,
        text: content,
        author: bounded(firstValue(raw, ['userNick', 'author', 'user']), 120),
        date: bounded(firstValue(raw, ['feedbackDate', 'date', 'gmtCreate']), 80),
        rating: bounded(firstValue(raw, ['score', 'rating', 'rate']), 40),
        images: [...new Set(imageValues.map((value) => absoluteUrl(value, baseUrl)).filter(Boolean))].slice(0, 12),
        videos: [...new Set(videoValues.map((value) => absoluteUrl(value, baseUrl)).filter(Boolean))].slice(0, 4),
        source: 'dabi-rateList',
      });
      if (reviews.length >= maxReviewSamples) break;
    }
    if (reviews.length >= maxReviewSamples) break;
  }

  const collectAnswerTexts = (value) => {
    const values = Array.isArray(value) ? value : [value];
    const output = [];
    for (const entry of values) {
      if (entry && typeof entry === 'object') {
        const nested = firstValue(entry, ['answerTitle', 'answer', 'content', 'text', 'title']);
        for (const text of collectAnswerTexts(nested)) {
          if (text && !output.includes(text)) output.push(text);
        }
        continue;
      }
      const text = bounded(entry, 1800);
      if (text && !output.includes(text)) output.push(text);
    }
    return output;
  };

  for (const record of recordsFor('questions')) {
    if (questions.length >= maxQuestionSamples) break;
    const payload = unwrapDabiPayload(record?.data, 'questions');
    const list = Array.isArray(payload.questionList) ? payload.questionList : [];
    questionTotal = questionTotal || cleanText(firstValue(payload, ['totalCount', 'questionCount', 'total', 'count', 'totalNum']), 80);
    const next = booleanValue(payload.hasNext);
    if (next !== null) questionHasNext = next;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const question = bounded(firstValue(raw, ['questionTitle', 'question', 'title', 'text']), 1200);
      const date = bounded(firstValue(raw, ['gmtCreate', 'date', 'createTime']), 80);
      const answerValues = [
        ...collectAnswerTexts(raw.answer),
        ...collectAnswerTexts(raw.answerTitle),
        ...collectAnswerTexts(raw.reply),
        ...collectAnswerTexts(raw.sellerAnswer),
        ...collectAnswerTexts(raw.topAnswerList),
      ].filter((value, index, values) => value && values.indexOf(value) === index);
      const id = bounded(firstValue(raw, ['questionId', 'id']) || `${question}:${date}`, 160);
      if (!question || !id) continue;
      const existing = questionById.get(id);
      if (existing) {
        existing.answers = [...new Set([...(existing.answers || []), ...answerValues])];
        existing.answer = existing.answers.join('\n');
        if (!existing.date && date) existing.date = date;
        continue;
      }
      const item = {
        id,
        question,
        text: question,
        answers: answerValues,
        answer: answerValues.join('\n'),
        date,
        source: 'dabi-questionList',
      };
      questionById.set(id, item);
      questions.push(item);
      if (questions.length >= maxQuestionSamples) break;
    }
  }

  for (const record of recordsFor('detail')) {
    const payload = unwrapDabiPayload(record?.data, 'detail');
    const components = payload.components;
    if (!components || typeof components !== 'object') continue;
    const layout = Array.isArray(components.layout) ? components.layout : [];
    const componentData = components.componentData && typeof components.componentData === 'object' ? components.componentData : {};
    for (const entry of layout) {
      const model = componentData[entry?.ID]?.model;
      if (!model || typeof model !== 'object') continue;
      addDetail(model.picUrl);
      if (typeof model.text === 'string') {
        const detailText = bounded(model.text.replace(/<[^>]+>/g, ' '), 3000);
        if (detailText) detailTexts.push(detailText);
        detailMediaFromHtml(model.text, addDetail);
      }
    }
  }

  return {
    reviews: reviews.slice(0, maxReviewSamples),
    questions: questions.slice(0, maxQuestionSamples),
    detail: {
      text: bounded(detailTexts.filter(Boolean).join(' '), 30000),
      sections: detailTexts.filter(Boolean).slice(0, 40).map((value) => ({ title: '图文详情可见内容', text: value, score: null })),
      images: detailImages.slice(0, 240),
    },
    reviewStats: {
      sampleCount: reviews.length,
      totalCount: reviewTotal,
      responseCount: recordsFor('reviews').length,
      pageCount: recordsFor('reviews').length,
      hasNext: reviewHasNext,
    },
    questionStats: {
      sampleCount: questions.length,
      totalCount: questionTotal,
      responseCount: recordsFor('questions').length,
      pageCount: recordsFor('questions').length,
      hasNext: questionHasNext,
    },
  };
}

module.exports = {
  DABI_ENDPOINTS,
  classifyDabiEndpoint,
  parseDabiResponseBody,
  unwrapDabiPayload,
  parseDabiNetworkRecords,
};
