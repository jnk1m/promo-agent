// 모델 호출 방어: 일일 상한(전체, 주소별), 끄기 스위치. 넘으면 템플릿으로.
import { createEnvClient, type LlmClient } from './client';

const DAILY_GLOBAL = Number(process.env.LLM_DAILY_GLOBAL ?? 400);
const DAILY_PER_IP = Number(process.env.LLM_DAILY_PER_IP ?? 40);

type Counter = { day: string; count: number };
const perIp = new Map<string, Counter>();
let global: Counter = { day: '', count: 0 };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export type GuardResult = { client: LlmClient | null; reason: string | null };

export async function guardedClient(ip: string): Promise<GuardResult> {
  if (process.env.LLM_DISABLED === '1') return { client: null, reason: '모델 호출이 꺼져 있어 템플릿 문장을 씁니다' };
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) return { client: null, reason: '모델 키가 없어 템플릿 문장을 씁니다' };
  const d = today();
  if (global.day !== d) global = { day: d, count: 0 };
  const c = perIp.get(ip);
  const mine = c && c.day === d ? c : { day: d, count: 0 };
  if (global.count >= DAILY_GLOBAL) return { client: null, reason: '오늘 전체 모델 호출 상한에 닿아 템플릿 문장을 씁니다' };
  if (mine.count >= DAILY_PER_IP) return { client: null, reason: '이 주소의 오늘 모델 호출 상한에 닿아 템플릿 문장을 씁니다' };
  global.count += 1;
  mine.count += 1;
  perIp.set(ip, mine);
  try {
    return { client: await createEnvClient(), reason: null };
  } catch (e) {
    return { client: null, reason: `모델 설정 오류: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function ipOf(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
}
