/**
 * 验证码提取引擎（REQ-202610-1254）。
 *
 * 纯函数：无 I/O、无模块级可变状态，相同输入恒定输出，可直接单测。
 * 输入短信原文，输出 { extracted_code, type }；type 为 'verification_code' | 'text'。
 *
 * 提取策略（宁缺勿滥，误提取可控）：
 * 1. 候选：4-8 位连续数字，或单空格分隔的数字组（如「1 2 3 4 5 6」）合并后 4-8 位；
 * 2. 硬排除：超长数字串的一部分、日期片段、金额（币种/单位/小数/千分位）、
 *    字母数字混排 token、负向关键词（订单号/取件码/优惠码等）紧邻的那个数字；
 * 3. 打分：仅当候选紧邻正向关键词（验证码/校验码/动态码/…/code）且得分达到阈值才提取，
 *    关键词越近得分越高，避免「文中有验证码字样但数字其实无关」的误提取；
 * 4. 多候选并存时取最高分，同分取靠前者。
 *
 * 「自动提取」开关：extractCode(text, { autoExtract: false }) 直接返回原文语义
 * （extracted_code 为 null、type 为 'text'），由调用方（采集接口 / 后台设置）决定是否启用。
 */

const TYPE_CODE = 'verification_code';
const TYPE_TEXT = 'text';

const MIN_DIGITS = 4;
const MAX_DIGITS = 8;

/** 候选得分阈值：低于该值不提取。 */
const SCORE_THRESHOLD = 60;
/** 关键词与候选之间的最大字符间距，超出即不认为二者相关。 */
const WINDOW_AFTER_KEYWORD = 24;
const WINDOW_BEFORE_KEYWORD = 12;
/** 负向关键词只排除紧随其后的第一个数字（它才是该词描述的对象）。 */
const NEGATIVE_KEYWORD_WINDOW = 12;
/** 距离衰减上限：得分 = 权重 - min(间距, 20)。 */
const MAX_DISTANCE_PENALTY = 20;

/** 正向关键词及权重（分值 = 权重 - 间距）。 */
const POSITIVE_KEYWORDS = [
  {
    weight: 100,
    pattern:
      /(?:验证码|校验码|动态码|动态密码|动态口令|一次性密码|一次性口令|短信密码|验证口令|安全代码|安全码|口令)/g,
  },
  {
    weight: 100,
    pattern:
      /\b(?:verification|security|authentication|one[- ]time|login|sign[- ]?in)\s+code\b/gi,
  },
  { weight: 80, pattern: /\b(?:otp|pin)\b/gi },
  { weight: 70, pattern: /\bcode\b/gi },
];

/** 负向关键词：紧邻其后的数字视为误报（订单号、金额凭证、优惠码等）。 */
const NEGATIVE_KEYWORDS = [
  /(?:订单号|单号|运单号|快递单号|流水号|交易号|编号|卡号|尾号|后四位|取件码|取货码|优惠码|折扣码|促销码|兑换码|房间号|房号|工号|学号|座位号|航班号|车次)/g,
  /\b(?:promo|discount|coupon|zip|postal|area|bar|batch|room)\s+code\b/gi,
  /\b(?:order|tracking|invoice|ticket|booking|reference|confirmation)\s*(?:number|no\.?|id|#)/gi,
];

/** 日期片段（整体排除其中的数字）。 */
const DATE_PATTERNS = [
  /\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?/g,
  /\d{1,2}月\d{1,2}日/g,
  /\d{4}年/g,
];

/** 金额判定：候选前紧邻币种符号，或后紧邻计量单位/小数/千分位。 */
const CURRENCY_BEFORE = /(?:[¥￥$€£]|RMB|USD|CNY)\s*$/;
const UNIT_AFTER =
  /^\s*(?:元|块|万元|万|美元|欧元|港币|日元|折|%|％|积分|GB|MB|KB|TB|kg|克|千米|公里|米|人|件|次|天|小时|分钟|秒)/;

/**
 * 从短信原文提取验证码。
 *
 * @param {string} text 短信原文。
 * @param {{ autoExtract?: boolean }} [options] autoExtract 为 false 时关闭自动提取，仅按原文处理。
 * @returns {{ extracted_code: string | null, type: 'verification_code' | 'text' }}
 */
export function extractCode(text, options = {}) {
  const { autoExtract = true } = options ?? {};
  if (!autoExtract || typeof text !== 'string' || text.length === 0) {
    return { extracted_code: null, type: TYPE_TEXT };
  }

  const source = normalizeDigits(text);
  const candidates = findCandidates(source);
  const negativeHits = markNegativeKeywordTargets(source, candidates);
  const dateRanges = findDateRanges(source);

  let best = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (negativeHits.has(i)) continue;
    if (isInsideRange(candidate, dateRanges)) continue;
    if (isAmountLike(source, candidate)) continue;
    if (isAlphanumericToken(source, candidate)) continue;
    const score = scoreCandidate(source, candidate);
    if (score < SCORE_THRESHOLD) continue;
    if (best === null || score > best.score)
      best = { code: candidate.code, score };
  }

  return best === null
    ? { extracted_code: null, type: TYPE_TEXT }
    : { extracted_code: best.code, type: TYPE_CODE };
}

/** 全角数字归一化为半角，返回新字符串。 */
function normalizeDigits(text) {
  return text.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  );
}

/**
 * 找出所有候选：4-8 位连续数字；单空格分隔的数字组合并后 4-8 位。
 * 返回按出现位置排序、互不重叠的候选列表。
 */
function findCandidates(text) {
  const found = [];
  for (const match of text.matchAll(/(?<!\d)(\d{4,8})(?!\d)/g)) {
    found.push({
      code: match[1],
      start: match.index,
      end: match.index + match[1].length,
    });
  }
  for (const match of text.matchAll(
    /(?<!\d)(?<!\d )(\d{1,4}(?: \d{1,4})+)(?!\d)(?! \d)/g,
  )) {
    const code = match[1].replace(/ /g, '');
    if (code.length < MIN_DIGITS || code.length > MAX_DIGITS) continue;
    found.push({
      code,
      start: match.index,
      end: match.index + match[1].length,
    });
  }

  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  let lastEnd = 0;
  for (const candidate of found) {
    if (candidate.start < lastEnd) continue;
    kept.push(candidate);
    lastEnd = candidate.end;
  }
  return kept;
}

/**
 * 负向关键词命中：每个关键词只吞掉紧随其后的第一个候选（即它所描述的那个数字），
 * 返回需要排除的候选下标集合。
 */
function markNegativeKeywordTargets(text, candidates) {
  const excluded = new Set();
  for (const pattern of NEGATIVE_KEYWORDS) {
    for (const match of text.matchAll(pattern)) {
      const keywordEnd = match.index + match[0].length;
      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        if (candidate.start < keywordEnd) continue;
        if (candidate.start - keywordEnd > NEGATIVE_KEYWORD_WINDOW) break;
        excluded.add(i);
        break;
      }
    }
  }
  return excluded;
}

function findDateRanges(text) {
  const ranges = [];
  for (const pattern of DATE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }
  return ranges;
}

function isInsideRange(candidate, ranges) {
  return ranges.some(
    ([start, end]) => candidate.start >= start && candidate.start < end,
  );
}

function isAmountLike(text, candidate) {
  const before = text.slice(0, candidate.start);
  const after = text.slice(candidate.end);
  if (CURRENCY_BEFORE.test(before)) return true;
  if (UNIT_AFTER.test(after)) return true;
  if (/^\.\d/.test(after)) return true; // 小数：1234.56 的后半段
  if (/[\d.,]$/.test(before)) return true; // 小数/千分位：3.1234、12,345 的后半段
  return false;
}

function isAlphanumericToken(text, candidate) {
  const before = text.slice(0, candidate.start);
  const after = text.slice(candidate.end);
  return /[A-Za-z]$/.test(before) || /^[A-Za-z]/.test(after);
}

/** 正向关键词打分：取所有命中里最高的分值（权重 - 距离）。 */
function scoreCandidate(text, candidate) {
  let best = 0;
  for (const { weight, pattern } of POSITIVE_KEYWORDS) {
    for (const match of text.matchAll(pattern)) {
      const keywordEnd = match.index + match[0].length;
      let gap;
      if (candidate.start >= keywordEnd) {
        gap = candidate.start - keywordEnd;
        if (gap > WINDOW_AFTER_KEYWORD) continue;
      } else if (match.index >= candidate.end) {
        gap = match.index - candidate.end;
        if (gap > WINDOW_BEFORE_KEYWORD) continue;
      } else {
        continue;
      }
      const score = weight - Math.min(gap, MAX_DISTANCE_PENALTY);
      if (score > best) best = score;
    }
  }
  return best;
}
