import type { AiConfig, PresentationSlide, ProblemData } from '../types.js';

export interface AiVisionTestResult {
  success: boolean;
  message: string;
  elapsedMs: number;
}

export interface AiSolveResult {
  options: string[];
  textAnswer: string;
  requiresHandwritingOrPhoto: boolean;
  confidence: string;
  reason: string;
  modelName: string;
  elapsedMs: number;
  usedImage: boolean;
}

const TINY_TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const PHOTO_REQUIREMENT_KEYWORDS = [
  '拍照上传',
  '拍照提交',
  '手写拍照',
  '在纸上',
  '纸上作答',
  '纸上写出',
  '纸上完成',
  '上传图片',
  '上传照片',
  '拍图上传',
  '手写并拍照',
  '手写上传',
  '画图上传',
];

export function hasAiCredentials(config?: AiConfig | null): config is AiConfig {
  return Boolean(
    config &&
      config.baseUrl.trim() &&
      config.apiKey.trim() &&
      config.model.trim()
  );
}

export function isAiReady(config?: AiConfig | null): config is AiConfig {
  return Boolean(config?.enabled && hasAiCredentials(config));
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

export function containsPhotoKeyword(text: string): boolean {
  if (!text) return false;
  return PHOTO_REQUIREMENT_KEYWORDS.some((kw) => text.includes(kw));
}

function problemTypeLabel(type: number): string {
  switch (type) {
    case 1:
      return '单选题';
    case 2:
      return '多选题';
    case 3:
      return '投票题';
    case 4:
      return '填空题';
    case 5:
      return '主观题';
    case 6:
      return '判断题';
    default:
      return '未知题型';
  }
}

async function downloadImageAsDataUri(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) return null;
    const ct = (resp.headers.get('content-type') ?? '').toLowerCase();
    let mime = 'image/jpeg';
    if (ct.includes('png') || url.toLowerCase().includes('.png')) {
      mime = 'image/png';
    } else if (ct.includes('webp') || url.toLowerCase().includes('.webp')) {
      mime = 'image/webp';
    }
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function extractMessageText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const choices = (data as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === 'object' && 'text' in part
          ? String((part as Record<string, unknown>).text ?? '')
          : ''
      )
      .join('')
      .trim();
  }
  return '';
}

function extractErrorMessage(data: unknown, statusCode: number): string {
  let detail = '';
  if (data && typeof data === 'object') {
    const map = data as Record<string, unknown>;
    const err = map.error as Record<string, unknown> | undefined;
    if (err && typeof err === 'object' && err.message) {
      detail = String(err.message);
    } else if (map.message) {
      detail = String(map.message);
    }
  } else if (typeof data === 'string' && data.trim()) {
    detail = data.trim();
  }
  if (detail.length > 160) {
    detail = `${detail.slice(0, 160)}...`;
  }
  if (statusCode === 401) {
    return `鉴权失败 (401)：API Key 无效或已过期${detail ? `（${detail}）` : ''}`;
  }
  if (statusCode === 404) {
    return `接口或模型不存在 (404)：请检查 Base URL 与模型名称${detail ? `（${detail}）` : ''}`;
  }
  if (statusCode === 400 && detail.toLowerCase().includes('image')) {
    return `该模型不支持看图输入 (400)：请切换视觉多模态模型（${detail}）`;
  }
  return `请求异常 (HTTP ${statusCode})${detail ? `：${detail}` : ''}`;
}

export function parseAiJsonObject(raw: string): Record<string, unknown> {
  let text = raw.trim();
  if (text.startsWith('```')) {
    const firstNl = text.indexOf('\n');
    if (firstNl !== -1) text = text.slice(firstNl + 1);
    const lastFence = text.lastIndexOf('```');
    if (lastFence !== -1) text = text.slice(0, lastFence);
    text = text.trim();
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    text = text.slice(start, end + 1);
  }
  const decoded = JSON.parse(text);
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('AI 返回的 JSON 结构不是对象');
  }
  return decoded as Record<string, unknown>;
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((e) => (e === null || e === undefined ? '' : String(e).trim()))
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function mapSingleOption(candidate: string, validKeys: string[]): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (validKeys.length === 0) return trimmed.toUpperCase();

  for (const key of validKeys) {
    if (key.toLowerCase() === trimmed.toLowerCase()) return key;
  }

  const leading = /^([A-Ha-h])[.\s、:：]/.exec(trimmed);
  if (leading) {
    const letter = leading[1].toLowerCase();
    for (const key of validKeys) {
      if (key.toLowerCase() === letter) return key;
    }
  }

  const lower = trimmed.toLowerCase();
  const trueAliases = new Set(['true', 't', '对', '正确', '√', '是', 'yes', '1']);
  const falseAliases = new Set(['false', 'f', '错', '错误', '×', '否', 'no', '0']);
  if (trueAliases.has(lower)) {
    for (const key of validKeys) {
      if (key.toLowerCase() === 'true' || key.toUpperCase() === 'A') return key;
    }
  }
  if (falseAliases.has(lower)) {
    for (const key of validKeys) {
      if (key.toLowerCase() === 'false' || key.toUpperCase() === 'B') return key;
    }
  }
  return null;
}

export function validateChoiceOptions(params: {
  rawOptions: string[];
  validKeys: string[];
  problemType: number;
  pollingCount?: number;
}): string[] {
  const { rawOptions, validKeys, problemType, pollingCount } = params;
  if (rawOptions.length === 0) return [];

  const expanded: string[] = [];
  for (const raw of rawOptions) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    if (validKeys.some((k) => k.toLowerCase() === cleaned.toLowerCase())) {
      expanded.push(cleaned);
      continue;
    }
    if (
      cleaned.length > 1 &&
      /^[A-Za-z]+$/.test(cleaned) &&
      validKeys.every((k) => k.length === 1)
    ) {
      for (const ch of cleaned) expanded.push(ch);
      continue;
    }
    expanded.push(cleaned);
  }

  const matched: string[] = [];
  for (const cand of expanded) {
    const mapped = mapSingleOption(cand, validKeys);
    if (mapped && !matched.includes(mapped)) {
      matched.push(mapped);
    }
  }
  if (matched.length === 0) return [];

  if (validKeys.length > 0) {
    matched.sort((a, b) => validKeys.indexOf(a) - validKeys.indexOf(b));
  }

  if (problemType === 1 || problemType === 6) {
    return [matched[0]];
  }
  if (problemType === 3) {
    const limit = pollingCount && pollingCount > 0 ? pollingCount : 1;
    return matched.slice(0, limit);
  }
  return matched;
}

export async function testVisionConnection(
  config: AiConfig
): Promise<AiVisionTestResult> {
  if (!hasAiCredentials(config)) {
    return {
      success: false,
      message: '请先填写完整的 Base URL、API Key 与视觉模型名称',
      elapsedMs: 0,
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(buildChatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model.trim(),
        temperature: 0.0,
        max_tokens: 32,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '这是一个看图接口连通性测试，请仅回复 OK 两个字母。',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${TINY_TEST_PNG_BASE64}`,
                },
              },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });

    const elapsedMs = Date.now() - startedAt;
    const text = await resp.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep raw text
    }

    if (resp.ok) {
      const content = extractMessageText(parsed);
      if (content) {
        return {
          success: true,
          message: `视觉看图接口验证成功（延迟 ${elapsedMs}ms）`,
          elapsedMs,
        };
      }
      return {
        success: false,
        message: '接口返回成功但未包含有效回复内容，请检查模型名称',
        elapsedMs,
      };
    }

    return {
      success: false,
      message: extractErrorMessage(parsed, resp.status),
      elapsedMs,
    };
  } catch (err) {
    return {
      success: false,
      message: `请求失败：${String(err).slice(0, 140)}`,
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function solveProblemWithVisionAi(params: {
  config: AiConfig;
  problem: ProblemData;
  slide?: PresentationSlide;
  courseTitle?: string;
}): Promise<AiSolveResult> {
  const { config, problem, slide, courseTitle } = params;
  if (!hasAiCredentials(config)) {
    throw new Error('未配置完整的 AI 视觉模型参数');
  }

  const startedAt = Date.now();
  let imageDataUri: string | null = null;
  const candidateUrls: string[] = [];
  if (slide) {
    for (const u of [slide.coverAlt, slide.cover, slide.thumbnail]) {
      const trimmed = (u ?? '').trim();
      if (trimmed && !candidateUrls.includes(trimmed)) {
        candidateUrls.push(trimmed);
      }
    }
  }
  for (const url of candidateUrls) {
    imageDataUri = await downloadImageAsDataUri(url);
    if (imageDataUri) break;
  }

  const shapeTexts = (slide?.shapes ?? [])
    .map((s) => (s.text ?? '').trim())
    .filter(Boolean);
  const pptShapeText = shapeTexts.join('\n');
  const localPhotoHint =
    containsPhotoKeyword(problem.body) || containsPhotoKeyword(pptShapeText);

  const typeLabel = problemTypeLabel(problem.problemType);
  const optionKeys = problem.options
    .map((o) => o.key.trim())
    .filter(Boolean);
  const optionsDesc = problem.options
    .map((o) =>
      o.value.trim()
        ? `- 选项键 "${o.key}": ${o.value.trim()}`
        : `- 选项键 "${o.key}"（内容请看 PPT 图片）`
    )
    .join('\n');
  const blankCount = problem.blanks.length || 1;

  const lines: string[] = [
    '请结合提供的雨课堂 PPT 题目图片与下方元数据，严谨解答本题。',
    `课程名称：${courseTitle?.trim() || '未知课程'}`,
    `题型：${typeLabel} (problemType=${problem.problemType})`,
    problem.body.trim()
      ? `接口题干文本：${problem.body.trim()}`
      : '接口题干文本为空，请直接仔细阅读 PPT 图片中的题干、公式、图表与选项！',
  ];

  if (pptShapeText) {
    lines.push(`PPT 文本框提取内容：\n${pptShapeText}`);
  }

  if (
    problem.problemType === 1 ||
    problem.problemType === 2 ||
    problem.problemType === 3 ||
    problem.problemType === 6
  ) {
    lines.push(
      `可用选项键列表（必须严格从下列键中选择）：${optionKeys.join(', ')}`
    );
    lines.push(optionsDesc);
    if (problem.problemType === 1 || problem.problemType === 6) {
      lines.push(
        '约束：本题为单选/判断题，options 数组必须且只能包含 1 个最准确的选项键。'
      );
    } else if (problem.problemType === 2) {
      lines.push(
        '约束：本题为多选题，options 数组包含所有正确选项键（通常 2 个及以上）。'
      );
    } else {
      const maxPoll = problem.pollingCount ?? 1;
      lines.push(
        `约束：本题为投票题，请选出最合理或主流的选项键，options 数量为 1~${maxPoll} 项。`
      );
    }
  } else if (problem.problemType === 4) {
    lines.push(
      `约束：本题为填空题，共有 ${blankCount} 个空。请在 blanks 数组中严格按顺序给出 ${blankCount} 个简洁精准的填空字符串（不要带多余标点或序号）。`
    );
  } else if (problem.problemType === 5) {
    lines.push(
      '约束：本题为主观简答题。请在 textAnswer 中用简洁自然的大学生课堂作答口吻写出要点清晰的答案（不要说“作为AI”）。同时仔细检查图片或题干是否要求“手写拍照上传 / 在纸上写出过程拍照上传”，若要求请将 requiresHandwritingOrPhoto 设为 true。'
    );
  }

  lines.push(`请**严格仅输出一个合法的 JSON 对象**（不要输出任何额外说明或 Markdown 以外的文字），格式如下：
{
  "options": ["选项键，仅单选/多选/投票/判断题填写，否则留空数组 []"],
  "blanks": ["填空答案，仅填空题填写，否则留空数组 []"],
  "textAnswer": "主观题答案，仅主观题填写，否则留空字符串",
  "requiresHandwritingOrPhoto": false,
  "confidence": "high",
  "reason": "一到两句简短中文解题依据"
}`);

  const userContent: Array<Record<string, unknown>> = [
    { type: 'text', text: lines.join('\n') },
  ];
  if (imageDataUri) {
    userContent.push({
      type: 'image_url',
      image_url: { url: imageDataUri },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let resp: Response;
  let bodyText: string;
  try {
    resp = await fetch(buildChatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model.trim(),
        temperature: 0.15,
        max_tokens: 1024,
        messages: [
          {
            role: 'system',
            content:
              '你是一位精通大学各学科（高数、线代、物理、计算机、思政、英语、经管等）的随堂解题专家。你必须仔细观察 PPT 图片中的每一个公式符号、下标与选项，只返回严格合法的 JSON 对象。',
          },
          {
            role: 'user',
            content: userContent,
          },
        ],
      }),
      signal: controller.signal,
    });
    bodyText = await resp.text();
  } finally {
    clearTimeout(timer);
  }

  const elapsedMs = Date.now() - startedAt;
  let respJson: unknown = bodyText;
  try {
    respJson = JSON.parse(bodyText);
  } catch {
    // keep raw
  }

  if (!resp.ok) {
    throw new Error(extractErrorMessage(respJson, resp.status));
  }

  const rawText = extractMessageText(respJson);
  if (!rawText) {
    throw new Error('AI 返回内容为空');
  }

  const parsed = parseAiJsonObject(rawText);
  const aiRequiresPhoto = parsed.requiresHandwritingOrPhoto === true;
  const confidence =
    typeof parsed.confidence === 'string' && parsed.confidence.trim()
      ? parsed.confidence.trim().toLowerCase()
      : 'medium';
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';

  if (problem.problemType === 5) {
    let textAns =
      typeof parsed.textAnswer === 'string' ? parsed.textAnswer.trim() : '';
    if (!textAns && reason) textAns = reason;
    if (!textAns) throw new Error('AI 未能生成有效的主观题草稿');
    return {
      options: [],
      textAnswer: textAns,
      requiresHandwritingOrPhoto: aiRequiresPhoto || localPhotoHint,
      confidence,
      reason,
      modelName: config.model.trim(),
      elapsedMs,
      usedImage: imageDataUri !== null,
    };
  }

  if (problem.problemType === 4) {
    const rawBlanks = readStringList(parsed.blanks);
    const fallbackOpts = readStringList(parsed.options);
    const rawList = rawBlanks.length ? rawBlanks : fallbackOpts;
    const normalized = rawList.length
      ? rawList
      : typeof parsed.textAnswer === 'string' && parsed.textAnswer.trim()
        ? [parsed.textAnswer.trim()]
        : [];
    if (normalized.length === 0) {
      throw new Error('AI 未能给出有效填空答案');
    }
    const finalBlanks: string[] = [];
    for (let i = 0; i < blankCount; i++) {
      finalBlanks.push(
        i < normalized.length ? normalized[i] : normalized[normalized.length - 1]
      );
    }
    return {
      options: finalBlanks,
      textAnswer: '',
      requiresHandwritingOrPhoto: false,
      confidence,
      reason,
      modelName: config.model.trim(),
      elapsedMs,
      usedImage: imageDataUri !== null,
    };
  }

  const rawOptions = readStringList(parsed.options);
  const validated = validateChoiceOptions({
    rawOptions,
    validKeys: optionKeys,
    problemType: problem.problemType,
    pollingCount: problem.pollingCount,
  });
  if (validated.length === 0) {
    throw new Error(
      `AI 给出的选项 (${rawOptions.join(',')}) 与本题合法选项 (${optionKeys.join(',')}) 不匹配`
    );
  }

  return {
    options: validated,
    textAnswer: '',
    requiresHandwritingOrPhoto: false,
    confidence,
    reason,
    modelName: config.model.trim(),
    elapsedMs,
    usedImage: imageDataUri !== null,
  };
}
