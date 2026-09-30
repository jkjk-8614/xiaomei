'use strict';

// 商品洞察的网络数据层。
// 这里只处理当前用户已打开页面产生的、与商品分析直接相关的响应，
// 将平台返回的可读字段整理成分析台使用的最小数据结构。

const ENDPOINT_PATTERNS = Object.freeze({
  reviews: /(?:^|[/?])mtop\.taobao\.rate\.detaillist\.get(?:[/?]|$)/i,
  // Taobao has used several WDJ/WDK/Wenda aliases for the same 问大家
  // module.  Keep the match limited to the question namespace so other mtop
  // calls are not treated as Q&A responses.
  questions: /(?:^|[/?])mtop\.taobao\.(?=[^/?#]*(?:wdj|wdk|wenda|question|questions|ask|answer|qna|qa))[^/?#]+(?:[/?#]|$)/i,
  detail: /(?:^|[/?])mtop\.taobao\.detail\.getdesc(?:[/?]|$)/i,
});

function classifyCommerceEndpoint(value) {
  const url = String(value || '');
  for (const [kind, pattern] of Object.entries(ENDPOINT_PATTERNS)) {
    if (pattern.test(url)) return kind;
  }
  return '';
}

function parseCommerceResponse(raw) {
  if (raw && typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}

  // 兼容页面响应中的 JSONP 外壳或少量前缀，不执行返回内容。
  const start = text.search(/[\[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function findCommercePayload(value, kind = '') {
  const matches = {
    reviews: (node) => Array.isArray(node?.rateList),
    questions: (node) => [
      'questionList', 'qaList', 'qnaList', 'askList', 'questionItems', 'questions',
    ].some((key) => Array.isArray(node?.[key])),
    detail: (node) => Boolean(node?.components && typeof node.components === 'object'),
  };
  const accepts = matches[kind] || ((node) => Boolean(
    node?.rateList || node?.questionList || node?.qaList || node?.qnaList || node?.askList || node?.components,
  ));
  const queue = [value];
  const seen = new Set();
  const keys = ['data', 'result', 'response', 'model', 'payload', 'content', 'ret', 'returnValue', 'modelData', 'dataModel', 'bizData', 'pageData'];

  while (queue.length) {
    let current = queue.shift();
    if (typeof current === 'string') current = parseCommerceResponse(current);
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (accepts(current)) return current;
    if (Array.isArray(current)) {
      queue.push(...current.slice(0, 16));
      continue;
    }
    for (const key of keys) {
      if (current[key] !== undefined && current[key] !== null) queue.push(current[key]);
    }
  }
  return {};
}

function tidy(value, limit = 4000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function firstPresent(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function toAbsoluteUrl(value, baseUrl) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return new URL(raw.startsWith('//') ? `https:${raw}` : raw, baseUrl).href;
  } catch {
    return '';
  }
}

function asBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  return null;
}

function collectHtmlMedia(html, add) {
  const source = String(html || '');
  for (const tag of source.match(/<(?:img|video|source)\b[^>]*>/gi) || []) {
    const match = tag.match(/(?:src|data-src|data-original|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (match) add(match[1] || match[2] || match[3] || '');
  }
}

function parseCommerceNetworkRecords(records = {}, options = {}) {
  const baseUrl = String(options.baseUrl || 'https://item.taobao.com/');
  const reviewLimit = Math.max(20, Math.min(5000, Number(
    options.maxReviewSamples
      || process.env.XIAOMEI_COMMERCE_MAX_REVIEW_SAMPLES
      || process.env.COMMERCE_ANALYSIS_MAX_REVIEW_SAMPLES
      || 200,
  ) || 200));
  const questionLimit = Math.max(50, Math.min(5000, Number(
    options.maxQuestionSamples
      || process.env.XIAOMEI_COMMERCE_MAX_QUESTION_SAMPLES
      || process.env.COMMERCE_ANALYSIS_MAX_QUESTION_SAMPLES
      || 2000,
  ) || 2000));
  const listFor = (kind) => Array.isArray(records?.[kind]) ? records[kind] : [];
  const reviews = [];
  const questions = [];
  const questionById = new Map();
  const detailImages = [];
  const detailTexts = [];
  const reviewIds = new Set();
  const detailIds = new Set();
  let reviewTotal = '';
  let questionTotal = '';
  let reviewHasNext = null;
  let questionHasNext = null;

  const addDetailImage = (value) => {
    const url = toAbsoluteUrl(value, baseUrl);
    if (!/^https?:/i.test(url) || detailIds.has(url)) return;
    detailIds.add(url);
    detailImages.push(url);
  };
  const answerTexts = (value) => {
    const output = [];
    const visit = (entry) => {
      if (Array.isArray(entry)) {
        entry.forEach(visit);
        return;
      }
      if (entry && typeof entry === 'object') {
        for (const key of [
          'answerTitle', 'answer', 'answerContent', 'answerText', 'content', 'text', 'title',
          'reply', 'sellerAnswer', 'sellerReply', 'answerList', 'answerListV2', 'replyList',
        ]) visit(entry[key]);
        return;
      }
      const text = tidy(entry, 1800);
      if (text && !output.includes(text)) output.push(text);
    };
    visit(value);
    return output;
  };

  for (const record of listFor('reviews')) {
    const payload = findCommercePayload(record?.data, 'reviews');
    const list = Array.isArray(payload.rateList) ? payload.rateList : [];
    reviewTotal ||= tidy(firstPresent(payload, ['totalCount', 'rateCount', 'total', 'count', 'totalNum']), 80);
    const next = asBoolean(payload.hasNext);
    if (next !== null) reviewHasNext = next;
    for (const item of list) {
      if (!item || typeof item !== 'object' || reviews.length >= reviewLimit) break;
      const content = tidy(firstPresent(item, ['feedback', 'rateContent', 'content', 'text']), 1800);
      const id = tidy(firstPresent(item, ['id', 'rateId']) || `${content}:${firstPresent(item, ['feedbackDate', 'gmtCreate'])}`, 160);
      if (!content || !id || reviewIds.has(id)) continue;
      reviewIds.add(id);
      const images = Array.isArray(item.feedPicPathList) ? item.feedPicPathList : [];
      const rawVideos = [
        ...(Array.isArray(item.feedVideoPathList) ? item.feedVideoPathList : []),
        ...(Array.isArray(item.video?.cloudVideoUrl) ? item.video.cloudVideoUrl : item.video?.cloudVideoUrl ? [item.video.cloudVideoUrl] : []),
      ];
      reviews.push({
        id,
        content,
        text: content,
        author: tidy(firstPresent(item, ['userNick', 'author', 'user']), 120),
        date: tidy(firstPresent(item, ['feedbackDate', 'date', 'gmtCreate']), 80),
        rating: tidy(firstPresent(item, ['score', 'rating', 'rate']), 40),
        images: [...new Set(images.map((value) => toAbsoluteUrl(value, baseUrl)).filter(Boolean))].slice(0, 12),
        videos: [...new Set(rawVideos.map((value) => toAbsoluteUrl(value, baseUrl)).filter(Boolean))].slice(0, 4),
        source: 'commerce-rate-list',
      });
    }
    if (reviews.length >= reviewLimit) break;
  }

  for (const record of listFor('questions')) {
    const payload = findCommercePayload(record?.data, 'questions');
    const list = [
      payload.questionList, payload.qaList, payload.qnaList, payload.askList,
      payload.questionItems, payload.questions,
    ].find(Array.isArray) || [];
    questionTotal ||= tidy(firstPresent(payload, ['totalCount', 'questionCount', 'questionTotalCount', 'askCount', 'total', 'count', 'totalNum']), 80);
    const next = asBoolean(payload.hasNext);
    if (next !== null) questionHasNext = next;
    for (const item of list) {
      if (!item || typeof item !== 'object' || questions.length >= questionLimit) break;
      const question = tidy(firstPresent(item, ['questionTitle', 'questionContent', 'questionText', 'question', 'ask', 'askContent', 'title', 'text']), 1200);
      const date = tidy(firstPresent(item, ['gmtCreate', 'date', 'createTime']), 80);
      const answers = [
        answerTexts(item.answer), answerTexts(item.answerTitle), answerTexts(item.answerContent),
        answerTexts(item.reply), answerTexts(item.replyList), answerTexts(item.sellerAnswer),
        answerTexts(item.sellerReply), answerTexts(item.topAnswerList), answerTexts(item.answerList),
      ].flat().filter((value, index, values) => value && values.indexOf(value) === index);
      const id = tidy(firstPresent(item, ['questionId', 'id']) || `${question}:${date}`, 160);
      if (!question || !id) continue;
      const existing = questionById.get(id);
      if (existing) {
        existing.answers = [...new Set([...(existing.answers || []), ...answers])];
        existing.answer = existing.answers.join('\n');
        continue;
      }
      const normalized = {
        id,
        question,
        text: question,
        answers,
        answer: answers.join('\n'),
        date,
        source: 'commerce-question-list',
      };
      questionById.set(id, normalized);
      questions.push(normalized);
    }
    if (questions.length >= questionLimit) break;
  }

  for (const record of listFor('detail')) {
    const payload = findCommercePayload(record?.data, 'detail');
    const components = payload.components;
    if (!components || typeof components !== 'object') continue;
    const layout = Array.isArray(components.layout) ? components.layout : [];
    const models = components.componentData && typeof components.componentData === 'object'
      ? components.componentData
      : {};
    for (const entry of layout) {
      const model = models[entry?.ID]?.model;
      if (!model || typeof model !== 'object') continue;
      addDetailImage(model.picUrl);
      if (typeof model.text === 'string') {
        const text = tidy(model.text.replace(/<[^>]+>/g, ' '), 3000);
        if (text) detailTexts.push(text);
        collectHtmlMedia(model.text, addDetailImage);
      }
    }
  }

  return {
    reviews: reviews.slice(0, reviewLimit),
    questions: questions.slice(0, questionLimit),
    detail: {
      text: tidy(detailTexts.join(' '), 30000),
      sections: detailTexts.slice(0, 40).map((text) => ({ title: '图文详情可见内容', text, score: null })),
      images: detailImages.slice(0, 240),
    },
    reviewStats: {
      sampleCount: reviews.length,
      totalCount: reviewTotal,
      responseCount: listFor('reviews').length,
      pageCount: listFor('reviews').length,
      hasNext: reviewHasNext,
    },
    questionStats: {
      sampleCount: questions.length,
      totalCount: questionTotal,
      responseCount: listFor('questions').length,
      pageCount: listFor('questions').length,
      hasNext: questionHasNext,
    },
  };
}

module.exports = {
  ENDPOINT_PATTERNS,
  classifyCommerceEndpoint,
  parseCommerceResponse,
  findCommercePayload,
  parseCommerceNetworkRecords,
};
