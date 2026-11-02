// 수정 이유 해석의 기준선: 모델 없이 낱말 규칙만으로 제약 후보를 만든다.
// 모델 해석기(interpret.ts)가 이 기준선보다 나은지 재는 용도다. 화면에서는 쓰지 않는다.
import { CARD_LEVELS, CATEGORIES, DAYPARTS, type GiftId, type Menu, type ScheduledBroadcast } from '../domain';
import type { Interpretation } from '../ledger/constraints';

const WEAK = ['되도록', '가능하면', '웬만하면', '될 수 있으면', '가급적', '참고', '분위기', '선호', '좋겠', '신경 써'];
const BAN = ['빼', '제외', '금지', '쓰지 마', '쓰지 말', '넣지 마', '넣으면 안', '안 돼', '안 됩니다', '없이', '노노', '피하'];
const REQUIRE = ['꼭', '필수', '반드시', '고정', '로 가', '로 해', '넣어', '붙여'];

function giftsIn(text: string, menu: Menu): GiftId[] {
  const found = new Set<GiftId>();
  for (const g of menu.gifts) {
    if (g.id === 'none') continue;
    // 메뉴 이름의 괄호 안 설명(체험 구성품 같은)도 이름으로 친다
    const label = g.name.match(/\((.+)\)/)?.[1];
    if (label && text.includes(label)) found.add(g.id);
    if (new RegExp(`(사은품\\s*)?(?<![A-Z])${g.id}(?![A-Z])`).test(text)) found.add(g.id);
  }
  return [...found];
}

export function keywordInterpret(text: string, sb: ScheduledBroadcast, menu: Menu): Interpretation {
  const base = (kind: Interpretation['kind'], target: Interpretation['target'] = {}, confidence: Interpretation['confidence'] = 'low'): Interpretation => ({ kind, scope, target, duration, quote: text, confidence });

  const scope: Interpretation['scope'] = {};
  const cat = CATEGORIES.find((c) => text.includes(c));
  if (cat) scope.category = cat;
  const dp = DAYPARTS.find((d) => text.includes(d));
  if (dp) scope.daypart = dp;
  if (/이 상품|이 건/.test(text)) scope.productId = sb.productId;

  let duration: Interpretation['duration'] = { type: 'this_broadcast', broadcastId: sb.id };
  if (text.includes('당분간')) duration = { type: 'until_t', t: sb.t + 30 };
  if (/앞으로 쭉|항상|계속/.test(text)) duration = { type: 'always' };

  if (WEAK.some((w) => text.includes(w))) return base('note');

  const hasBan = BAN.some((w) => text.includes(w));
  const hasReq = REQUIRE.some((w) => text.includes(w));
  const gifts = giftsIn(text, menu);
  const mentionsCard = text.includes('카드');

  if (mentionsCard) {
    if (/올려|높여/.test(text)) return base('unclear');
    const nums = (text.match(/\d+/g) ?? []).map(Number);
    const levels = nums.filter((n) => (CARD_LEVELS as readonly number[]).includes(n));
    if (nums.length && levels.length === 0) return base('unclear');
    const zero = /없이|쓰지 마/.test(text);
    if (zero && levels.length) return base('unclear'); // 상한과 사용 금지가 같이 있음
    if (zero) return base('cap_card', { maxCardLevel: 0 }, 'high');
    if (levels.length === 1) return base('cap_card', { maxCardLevel: levels[0] as 0 | 5 | 7 | 10 }, 'high');
    if (levels.length > 1) {
      // 「10은 과해요. 7까지만」: 까지/이하/이내/제한/넘기 앞의 숫자를 상한으로
      const m = text.match(/(\d+)\s*(%|퍼센트)?\s*(까지|이하|이내|로 제한|를 넘기|넘기)/);
      const cap = m ? Number(m[1]) : NaN;
      if ((CARD_LEVELS as readonly number[]).includes(cap)) return base('cap_card', { maxCardLevel: cap as 0 | 5 | 7 | 10 }, 'low');
      return base('unclear');
    }
    return base('unclear');
  }

  if (gifts.length === 0) return base('unclear');
  if (gifts.length > 1) return base('unclear');
  if (hasBan && hasReq) return base('unclear');
  if (hasBan) return base('ban_gift', { giftId: gifts[0] }, 'high');
  if (hasReq) return base('require_gift', { giftId: gifts[0] }, 'high');
  return base('unclear');
}
