import crypto from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';

export const TEXT_MODELS = ['deepseek-flash', 'gpt-5.6-sol', 'gpt-6-sol', 'gpt-6.1-sol', 'gemini-3.8-flash'];
export const CATEGORY_LABELS = {
  general: '通用商品',
  home: '家居百货',
  apparel: '服饰鞋包',
  beauty: '美妆个护',
  digital: '数码家电',
  food: '食品饮料',
  fireplace: '壁炉',
  lighting: '灯饰',
  roman_shade: '罗马帘',
};
export const DIRECTION_LABELS = {
  ecommerce: '电商营销宣传',
  douyin: '抖音营销宣传',
  xiaohongshu: '小红书营销宣传',
  real_shoot: '真实实拍展示',
};

export function categoryDisplayLabel(category) {
  const value = String(category || '').trim();
  if (!value) return CATEGORY_LABELS.general;
  return CATEGORY_LABELS[value] || value;
}

export function normalizeContentOptions(input = {}) {
  const rawCategory = String(input.category || 'general').trim() || 'general';
  const category = rawCategory.length > 40 ? rawCategory.slice(0, 40) : rawCategory;
  const direction = String(input.direction || 'real_shoot');
  const textModel = String(input.textModel || TEXT_MODELS[0]);
  const voiceGender = String(input.voiceGender || 'female');
  const productFacts = String(input.productFacts || '').trim();
  const manualSpeech = String(input.manualSpeech || '').trim();
  const copywriting = input.copywriting === true;
  const reviewPrompt = input.reviewPrompt === true;
  if (/[\x00-\x1F]/.test(category)) throw new Error('商品分类包含无效字符');
  if (!DIRECTION_LABELS[direction]) throw new Error('文案创作方向无效');
  if (!TEXT_MODELS.includes(textModel)) throw new Error('文本模型无效');
  if (!['male', 'female'].includes(voiceGender)) throw new Error('人声音色无效');
  if (productFacts.length > 1500) throw new Error('商品信息不能超过 1500 字');
  if (manualSpeech.length > 500) throw new Error('口播文案不能超过 500 字');
  if (reviewPrompt && !copywriting) throw new Error('请先开启文案专家，再审核提示词');
  return {
    category,
    direction,
    textModel,
    copywriting,
    reviewPrompt,
    modelEnabled: input.modelEnabled === true,
    voiceover: input.voiceover === true,
    subtitles: input.subtitles === true,
    voiceGender,
    productFacts,
    manualSpeech,
  };
}

export function groupFingerprint(group) {
  const files = group.files.map((file) => [file.relativePath, file.size, file.thumbnailUrl]);
  return crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

export async function imageContactSheets(group, materialDir) {
  if (!group.files.length) throw new Error(`${group.name} 没有可识别的参考图片`);
  const sheets = [];
  for (let offset = 0; offset < group.files.length; offset += 6) {
    const files = group.files.slice(offset, offset + 6);
    const tiles = [];
    for (const [index, file] of files.entries()) {
      const source = path.resolve(materialDir, file.relativePath);
      if (!source.startsWith(`${path.resolve(materialDir)}${path.sep}`)) throw new Error('素材路径无效');
      let tile;
      try {
        tile = await sharp(source).rotate().resize(640, 640, { fit: 'contain', background: '#ffffff' }).jpeg({ quality: 84 }).toBuffer();
      } catch (error) {
        throw new Error(`${group.name} 的图片 ${file.name} 无法识别：${error.message}`);
      }
      tiles.push({ input: tile, left: (index % 3) * 640, top: Math.floor(index / 3) * 640 });
    }
    const sheet = await sharp({ create: { width: 1920, height: 1280, channels: 3, background: '#ffffff' } })
      .composite(tiles).jpeg({ quality: 85 }).toBuffer();
    sheets.push(`data:image/jpeg;base64,${sheet.toString('base64')}`);
  }
  return sheets;
}

export async function modelImageDataUrls(references, materialDir) {
  const urls = [];
  for (const reference of references) {
    const source = path.resolve(materialDir, reference.relativePath);
    if (!source.startsWith(`${path.resolve(materialDir)}${path.sep}`)) throw new Error('模特图片路径无效');
    try {
      const image = await sharp(source).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 86 }).toBuffer();
      urls.push(`data:image/jpeg;base64,${image.toString('base64')}`);
    } catch (error) {
      throw new Error(`模特图片 ${reference.name} 无法识别：${error.message}`);
    }
  }
  return urls;
}

export function copyMessages(group, options, basePrompt, duration, imageDataUrls, modelDataUrls = [], externalVoiceover = false) {
  if (!imageDataUrls?.length) throw new Error('文案策划必须提供参考图片');
  const imageNames = group.files.map((file) => file.name).slice(0, 30).join('、');
  const speechMin = Math.max(12, Math.round(duration * (externalVoiceover ? 3.1 : 3.7)));
  const speechMax = Math.max(speechMin + 3, Math.round(duration * (externalVoiceover ? 3.5 : 4.2)));
  return [
    {
      role: 'system',
      content: [
        '你是短视频文案策划。必须先观察用户提供的真实参考图片，再写内容；不要只根据文件名、分类或用户的愿望猜测图片内容。前面的单张图片若存在，是模特外貌参考；后面的拼图才是商品和场景参考，不能把模特照的背景当作商品场景。',
        '仅返回一个有效 JSON 对象，字段为 imageReadable（布尔值）、visualFacts（从商品场景图片直接观察到的具体事实字符串数组）、title、openingHook、videoPrompt、spokenText。看不清商品或场景时 imageReadable 为 false，visualFacts 为空，不要编写脚本。',
        '面向短视频观看节奏，文案像真实体验者与观众交流，亲切、有互动感，但不过度推销。openingHook 写前 1-3 秒的具体画面和简短钩子，利用图片里真实可见的细节提出轻巧的问题或观察，让观众想继续看；后续画面应自然回应开场。不要虚构悬念、喊口号、夸大效果或套用硬广话术。',
        'videoPrompt 是给视频模型的可执行画面脚本，开场落实 openingHook，随后用有变化的镜头展示商品和空间；只描述图中可见的商品、空间、颜色、构图和允许的镜头变化。有模特图时让同一模特自然出现在商品场景中，保留可见的外貌特征；要求添加模特但没有模特图时，自然加入一位亚洲女性模特，不要声称其外貌来自参考图。用户要求与图片不符时以图片为准。',
        'spokenText 是由多句简短、连贯的话组成的完整中文口播，内容要足够支撑视频的大部分时长。开头呼应钩子，接着自然聊到图片中可见的两三个不同细节，以及它们在画面里的关系，结尾用一句轻松的回应或互动收住。像真实的人分享观察一样说话，有自然停顿和语气变化；不要念标题、堆形容词、机械播报或夸张叫卖。不能为了凑字数重复同一观点，也不能假称自己使用过商品或捏造尺寸、价格、功效、材质、认证及图片里没有的商品。不要使用 Markdown。',
      ].join(''),
    },
    {
      role: 'user',
      content: [{ type: 'text', text: [
        `商品分类：${categoryDisplayLabel(options.category)}`,
        `创作方向：${DIRECTION_LABELS[options.direction]}`,
        `素材组：${group.name}`,
        `图片文件名（与拼图顺序一致）：${imageNames || '未命名'}`,
        modelDataUrls.length ? `模特参考图：${modelDataUrls.length} 张，紧随本段文字，按顺序作为图 1 至图 ${modelDataUrls.length}。` : '未提供模特参考图。',
        options.modelEnabled ? (modelDataUrls.length ? '视频中使用这些模特图对应的人物，保持外貌一致。' : '视频中自然加入一位亚洲女性模特，人物形象可以随机设计，但同一视频内保持一致。') : '视频不需要模特。',
        '之后的场景拼图从左到右、从上到下排列 6 张原图。先列出能从场景图片看出的视觉事实，不能辨认时明确说明。',
        `已确认的商品信息：${options.productFacts || '未提供，不得补充具体参数'}`,
        `原始画面要求：${String(basePrompt).replaceAll('{group}', group.name)}`,
        `视频时长：${duration} 秒。spokenText 目标约 ${speechMin}–${speechMax} 个汉字（不计标点），用自然语速和停顿覆盖主要镜头；若图片信息不足，不要为了达到字数捏造内容。${externalVoiceover ? '口播将由 Fish Audio 单独配音，videoPrompt 只写无声画面，不要求视频模型生成口播、音乐、字幕或文字。' : 'videoPrompt 不要要求后期合成。'}`,
      ].join('\n') }, ...modelDataUrls.map((url) => ({ type: 'image_url', image_url: { url } })), ...imageDataUrls.map((url) => ({ type: 'image_url', image_url: { url } }))],
    },
  ];
}

export function speechRevisionMessages(spokenText, visualFacts, targetCharacters, maxSeconds) {
  return [
    { role: 'system', content: '你是短视频口播编辑。只精简原文，不增加新事实。保留真实、自然、有互动感的语气和开场钩子；删去重复或次要描述，不加速朗读，不编造商品信息。仅返回 JSON 对象，字段 spokenText。不要使用 Markdown。' },
    { role: 'user', content: JSON.stringify({ original: spokenText, visualFacts, targetCharacters, maxSeconds }) },
  ];
}

export function parseSpeechRevision(data, original) {
  const result = data?.data?.choices ? data.data : data;
  const content = result?.choices?.[0]?.message?.content ?? result?.output_text;
  const text = Array.isArray(content) ? content.map((part) => part.text || '').join('') : String(content || '');
  let revised;
  try { revised = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')).spokenText; }
  catch { throw new Error('文本模型未返回有效的精简口播'); }
  const speech = String(revised || '').trim();
  if (!speech || speech.length > 500 || speech.length >= String(original).trim().length) throw new Error('文本模型未能缩短口播');
  return speech;
}

export function parseCopyPlan(data) {
  const result = data?.data?.choices ? data.data : data;
  const content = result?.choices?.[0]?.message?.content ?? result?.output_text;
  const text = Array.isArray(content) ? content.map((part) => part.text || '').join('') : String(content || '');
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let plan;
  try { plan = JSON.parse(cleaned); } catch { throw new Error('文本模型未返回有效的 JSON 策划脚本'); }
  if (plan?.imageReadable !== true) throw new Error('文本模型未能确认看清参考图片，已停止生成');
  const visualFacts = Array.isArray(plan.visualFacts) ? plan.visualFacts.map((fact) => String(fact).trim()).filter(Boolean) : [];
  if (!visualFacts.length || visualFacts.length > 30 || visualFacts.some((fact) => fact.length > 250)) throw new Error('文本模型没有提供有效的图片观察记录，已停止生成');
  const title = String(plan?.title || '').trim();
  const openingHook = String(plan?.openingHook || '').trim();
  const videoPrompt = String(plan?.videoPrompt || '').trim();
  const spokenText = String(plan?.spokenText || '').trim();
  if (!title || !openingHook || !videoPrompt || !spokenText) throw new Error('文本模型返回的策划脚本缺少标题、开场钩子、画面或口播文案');
  if (title.length > 100 || openingHook.length > 250 || videoPrompt.length > 3500 || spokenText.length > 500) throw new Error('文本模型返回的策划脚本过长');
  return { title, visualFacts, openingHook, videoPrompt, spokenText };
}

export function composeVideoPrompt(basePrompt, groupName, options, plan = null, modelImageCount = 0, externalVoiceover = false) {
  const visual = plan?.videoPrompt || String(basePrompt || '').replaceAll('{group}', groupName).trim();
  const speech = plan?.spokenText || options.manualSpeech;
  const lines = [...(plan?.openingHook ? [`前 1-3 秒开场钩子：${plan.openingHook}`] : []), visual, `商品分类：${CATEGORY_LABELS[options.category]}。参考图片是商品与场景的外观依据，不要改变商品主体。`];
  if (modelImageCount) lines.push(`参考图 1${modelImageCount > 1 ? ` 至 ${modelImageCount}` : ''} 是同一模特的外貌参考，后续参考图是商品与场景。视频中使用这位模特，保持可见的面容、发型与服装特征，让模特自然出现在后续图片对应的商品场景中；不要照搬模特参考照的背景。`);
  else if (options.modelEnabled) lines.push('视频中自然加入一位亚洲女性模特，没有模特参考图时随机设计与商品场景协调的形象；同一视频内保持人物外貌一致，不要遮挡商品主体。');
  if (externalVoiceover) {
    lines.push('仅生成无声画面，口播由 Fish Audio 生成并自动合成；不要生成任何人声、音乐或音效。');
  } else if (options.voiceover) {
    lines.push(`视频直接生成自然的中文${options.voiceGender === 'male' ? '男声' : '女声'}口播，像真人向观众分享，语速从容，有自然停顿和互动语气，口播贯穿主要镜头，避免开头说几句后长时间静音；不要机械播报或夸张叫卖。${speech ? `按画面节奏完整朗读口播文案：${speech}` : '根据画面自然介绍商品，不编造未提供的参数。'}`);
  } else {
    lines.push('不添加人声口播或解说。');
  }
  if (options.subtitles) {
    lines.push(speech
      ? `画面内直接生成易读的简体中文字幕，文字内容：${speech}。${options.voiceover ? '字幕与口播同步。' : ''}`
      : '画面内直接生成简短、易读的简体中文字幕，不编造商品参数。');
  } else {
    lines.push('画面内不叠加字幕。');
  }
  return lines.join('\n');
}

export function videoPromptForGroup(basePrompt, groupName, options, plan, modelImageCount, reviewedPrompt, externalVoiceover = false) {
  if (!options.reviewPrompt) return composeVideoPrompt(basePrompt, groupName, options, plan, modelImageCount, externalVoiceover);
  const prompt = String(reviewedPrompt || '').trim();
  if (!prompt || prompt.length > 6000) throw new Error(`${groupName} 审核后的提示词必须在 1–6000 字以内`);
  return prompt;
}
