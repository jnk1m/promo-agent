import { z } from 'zod';

// 모든 데이터는 합성이다. 상품군, 시간대, 조건 메뉴는 가상의 예시다.

export const CATEGORIES = ['건강식품', '뷰티', '패션', '생활가전', '식품'] as const;
export type Category = (typeof CATEGORIES)[number];

export const DAYPARTS = ['아침', '낮', '저녁', '심야'] as const;
export type Daypart = (typeof DAYPARTS)[number];

export const CARD_LEVELS = [0, 5, 7, 10] as const; // 청구할인 %
export type CardLevel = (typeof CARD_LEVELS)[number];

export const GIFT_IDS = ['none', 'A', 'B', 'C'] as const;
export type GiftId = (typeof GIFT_IDS)[number];

export const GiftSchema = z.object({
  id: z.enum(GIFT_IDS),
  name: z.string(),
  unitCost: z.number().nonnegative(), // 주문 1건당 원가(원)
});
export type Gift = z.infer<typeof GiftSchema>;

export const DEFAULT_GIFTS: Gift[] = [
  { id: 'none', name: '사은품 없음', unitCost: 0 },
  { id: 'A', name: '사은품 A (소형 실용품)', unitCost: 1500 },
  { id: 'B', name: '사은품 B (체험 구성품)', unitCost: 6000 },
  { id: 'C', name: '사은품 C (본품 추가 구성)', unitCost: 3500 },
];

export const ProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(CATEGORIES),
  listPrice: z.number().positive(),
  marginRate: z.number().min(0).max(1), // 판매가 대비 매출총이익률(가정)
});
export type Product = z.infer<typeof ProductSchema>;

export const ComboSchema = z.object({
  cardLevel: z.union([z.literal(0), z.literal(5), z.literal(7), z.literal(10)]),
  giftId: z.enum(GIFT_IDS),
});
export type Combo = z.infer<typeof ComboSchema>;

export function comboKey(c: Combo): string {
  return `card${c.cardLevel}_${c.giftId}`;
}

export function allCombos(): Combo[] {
  const out: Combo[] = [];
  for (const cardLevel of CARD_LEVELS) for (const giftId of GIFT_IDS) out.push({ cardLevel, giftId });
  return out;
}

export const SlotSchema = z.object({
  category: z.enum(CATEGORIES),
  daypart: z.enum(DAYPARTS),
});
export type Slot = z.infer<typeof SlotSchema>;

export function slotKey(s: Slot): string {
  return `${s.category}|${s.daypart}`;
}

// 편성표의 한 줄(방송 예정)
export const ScheduledBroadcastSchema = z.object({
  id: z.string(),
  t: z.number().int().nonnegative(), // 방송 순번(시간 축)
  productId: z.string(),
  category: z.enum(CATEGORIES),
  daypart: z.enum(DAYPARTS),
  budget: z.number().nonnegative(), // 프로모션 비용 상한(원)
  marginFloor: z.number(), // 마진 하한(원). 중앙값 기준
  objective: z.enum(['revenue', 'margin']),
});
export type ScheduledBroadcast = z.infer<typeof ScheduledBroadcastSchema>;

// 방송 실적 한 건(관측 칸만. 참 함수 값은 없다)
export const BroadcastRecordSchema = ScheduledBroadcastSchema.omit({ budget: true, marginFloor: true, objective: true }).extend({
  cardLevel: z.union([z.literal(0), z.literal(5), z.literal(7), z.literal(10)]),
  giftId: z.enum(GIFT_IDS),
  listPrice: z.number().positive(),
  marginRate: z.number().min(0).max(1),
  orders: z.number().int().nonnegative(),
  cancelRate: z.number().min(0).max(1),
});
export type BroadcastRecord = z.infer<typeof BroadcastRecordSchema>;

// 조건 메뉴: 카드 청구할인의 회사 부담 비율은 모른다. 입력 칸이며 기본값은 가정이다.
export const MenuSchema = z.object({
  cardBurdenRatio: z.number().min(0).max(1), // 할인액 중 회사 부담 비율(가정)
  gifts: z.array(GiftSchema),
});
export type Menu = z.infer<typeof MenuSchema>;

export const DEFAULT_MENU: Menu = { cardBurdenRatio: 0.5, gifts: DEFAULT_GIFTS };

export function giftOf(menu: Menu, id: GiftId): Gift {
  const g = menu.gifts.find((x) => x.id === id);
  if (!g) throw new Error(`menu has no gift ${id}`);
  return g;
}

// 돈 계산(코드). 주문 수가 주어졌을 때 매출, 프로모션 비용, 마진.
export function money(orders: number, cancelRate: number, product: Pick<Product, 'listPrice' | 'marginRate'>, combo: Combo, menu: Menu) {
  const netOrders = orders * (1 - cancelRate);
  const revenue = netOrders * product.listPrice; // 청구할인은 판매가를 바꾸지 않는다
  const cardCost = revenue * (combo.cardLevel / 100) * menu.cardBurdenRatio;
  const giftCost = netOrders * giftOf(menu, combo.giftId).unitCost;
  const promoCost = cardCost + giftCost;
  const margin = revenue * product.marginRate - promoCost;
  return { netOrders, revenue, cardCost, giftCost, promoCost, margin };
}
