'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Combo, Product, ScheduledBroadcast } from '@/lib/domain';
import { newSession, SCHEDULE_LENGTH, type ProposalDto, type RunResult, type Session } from '@/lib/engine';
import type { ExplainResult } from '@/lib/llm/explain';
import type { Constraint } from '@/lib/ledger/constraints';
import type { ComboEval } from '@/lib/search/combos';
import type { DecisionRecord } from '@/lib/state';

type ProposeResponse = { sb: ScheduledBroadcast; product: Product; proposal: ProposalDto; explanation: ExplainResult; before: ProposalDto | null; llmNote: string | null; error?: string };
type InterpretResponse = { ok: boolean; attempts: number; candidate?: Constraint; description?: string; errors?: string[]; llmNote?: string | null; error?: string };

const CHIPS = ['사은품이 상품과 안 맞음', '카드 할인 폭이 과함', '협력사 요청', '사은품 재고 문제', '지난 방송 반응 참고', '기타'];
const STORAGE_KEY = 'promo-agent-session-v1';

const won = (n: number) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const comboLabel = (c: Combo, gifts: { id: string; name: string }[]) => `카드 ${c.cardLevel}% + ${gifts.find((g) => g.id === c.giftId)?.name ?? c.giftId}`;
const sameCombo = (a: Combo, b: Combo) => a.cardLevel === b.cardLevel && a.giftId === b.giftId;

function Badge({ kind }: { kind: '추정' | '계산' | '가정' | '합성' | '모델 문장' | '템플릿' }) {
  const color = { 추정: 'bg-blue-100 text-blue-800', 계산: 'bg-gray-100 text-gray-800', 가정: 'bg-amber-100 text-amber-800', 합성: 'bg-rose-100 text-rose-800', '모델 문장': 'bg-violet-100 text-violet-800', 템플릿: 'bg-gray-200 text-gray-700' }[kind];
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${color}`}>{kind}</span>;
}

function IntervalRow({ label, iv, badge, money }: { label: string; iv: { p10: number; p50: number; p90: number }; badge: '추정' | '계산'; money?: boolean }) {
  const f = (n: number) => (money ? won(n) : `${Math.round(n)}건`);
  return (
    <tr className="border-t border-gray-200">
      <td className="py-1 pr-2 text-gray-600">{label}</td>
      <td className="py-1 text-right tabular-nums">{f(iv.p10)}</td>
      <td className="py-1 text-right font-semibold tabular-nums">{f(iv.p50)}</td>
      <td className="py-1 text-right tabular-nums">{f(iv.p90)}</td>
      <td className="py-1 pl-2">
        <Badge kind={badge} />
      </td>
    </tr>
  );
}

export default function Agent() {
  const [session, setSession] = useState<Session>(() => newSession());
  const [hydrated, setHydrated] = useState(false);
  const [current, setCurrent] = useState<ProposeResponse | null>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'review' | 'modify' | 'decided' | 'ran'>('review');
  const [pickedCombo, setPickedCombo] = useState<Combo | null>(null);
  const [chips, setChips] = useState<string[]>([]);
  const [reasonText, setReasonText] = useState('');
  const [interp, setInterp] = useState<InterpretResponse | null>(null);
  const [finalCombo, setFinalCombo] = useState<Combo | null>(null);
  const [tab, setTab] = useState<'loop' | 'ledger' | 'promotion'>('loop');

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      /* 저장소 없음 */
    }
  }, [session, hydrated]);

  const doneIds = useMemo(() => new Set(session.outcomes.map((o) => o.id)), [session]);
  const nextIndex = session.outcomes.length;

  const propose = useCallback(
    async (s: Session, index: number, withBefore: boolean) => {
      setBusy('결정안을 만드는 중 (모델 문장 작성과 검증에 수 초)');
      setError(null);
      setCurrent(null);
      setRun(null);
      setInterp(null);
      setChips([]);
      setReasonText('');
      setPickedCombo(null);
      setFinalCombo(null);
      setMode('review');
      try {
        const id = `S${String(360 + index).padStart(4, '0')}`;
        const res = await fetch('/api/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: s, broadcastId: id, withBefore }) });
        const data = (await res.json()) as ProposeResponse;
        if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
        setCurrent(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // 처음 한 번: 저장된 세션을 읽고 첫 결정안을 만든다(브라우저 저장소는 보조 수단, 없어도 동작)
  useEffect(() => {
    const boot = async () => {
      let s = newSession();
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) s = JSON.parse(raw) as Session;
      } catch {
        /* 저장소 없음 */
      }
      setSession(s);
      setHydrated(true);
      if (s.outcomes.length < SCHEDULE_LENGTH) await propose(s, s.outcomes.length, s.outcomes.length > 0);
    };
    void boot();
  }, [propose]);

  const gifts = useMemo(() => [{ id: 'none', name: '사은품 없음' }, { id: 'A', name: '사은품 A (소형 실용품)' }, { id: 'B', name: '사은품 B (체험 구성품)' }, { id: 'C', name: '사은품 C (본품 추가 구성)' }], []);

  const reset = () => {
    const s = newSession();
    setSession(s);
    setCurrent(null);
    void propose(s, 0, false);
  };

  const approve = () => {
    if (!current?.proposal.chosen) return;
    setFinalCombo(current.proposal.chosen.combo);
    setMode('decided');
  };

  const interpret = async () => {
    if (!current || !reasonText.trim()) return;
    setBusy('이유를 해석하는 중');
    try {
      const res = await fetch('/api/interpret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session, broadcastId: current.sb.id, text: reasonText.trim() }) });
      const data = (await res.json()) as InterpretResponse;
      if (data.error) throw new Error(data.error);
      setInterp(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const confirmModify = (activate: boolean) => {
    if (!current || !pickedCombo) return;
    let ledger = session.ledger;
    const ids: string[] = [];
    if (activate && interp?.ok && interp.candidate && interp.candidate.kind !== 'unclear') {
      const c: Constraint = { ...interp.candidate, status: interp.candidate.kind === 'note' ? 'candidate' : 'active' };
      ledger = [...ledger, c];
      ids.push(c.id);
    }
    const chosen = current.proposal.chosen!;
    const pickedEval = current.proposal.evals.find((e) => sameCombo(e.combo, pickedCombo));
    const rec: DecisionRecord = {
      broadcastId: current.sb.id,
      t: current.sb.t,
      proposed: { cardLevel: chosen.combo.cardLevel, giftId: chosen.combo.giftId },
      final: { cardLevel: pickedCombo.cardLevel, giftId: pickedCombo.giftId },
      status: sameCombo(chosen.combo, pickedCombo) ? 'approved' : 'modified',
      reasonChips: chips,
      reasonText: reasonText.trim() || undefined,
      constraintIds: ids,
      predictedOrders: pickedEval?.orders ?? chosen.orders,
    };
    setSession({ ...session, ledger, decisions: [...session.decisions.filter((d) => d.broadcastId !== rec.broadcastId), rec] });
    setFinalCombo(pickedCombo);
    setMode('decided');
  };

  const runBroadcast = async () => {
    if (!current || !finalCombo) return;
    const chosen = current.proposal.chosen!;
    let s = session;
    if (!s.decisions.some((d) => d.broadcastId === current.sb.id)) {
      const rec: DecisionRecord = { broadcastId: current.sb.id, t: current.sb.t, proposed: { cardLevel: chosen.combo.cardLevel, giftId: chosen.combo.giftId }, final: { cardLevel: finalCombo.cardLevel, giftId: finalCombo.giftId }, status: 'approved', reasonChips: [], constraintIds: [], predictedOrders: chosen.orders };
      s = { ...s, decisions: [...s.decisions, rec] };
    }
    const pickedEval = current.proposal.evals.find((e) => sameCombo(e.combo, finalCombo)) ?? chosen;
    setBusy('합성 방송을 실행하는 중');
    try {
      const combosToShow = [finalCombo, ...current.proposal.alternatives.map((a) => a.eval.combo), ...(sameCombo(finalCombo, chosen.combo) ? [] : [chosen.combo])];
      const res = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: s, broadcastId: current.sb.id, finalCombo, predicted: { p10: pickedEval.orders.p10, p90: pickedEval.orders.p90 }, combosToShow }) });
      const data = (await res.json()) as RunResult & { error?: string };
      if (data.error) throw new Error(data.error);
      const decisions = s.decisions.map((d) => (d.broadcastId === current.sb.id ? { ...d, outcome: { orders: data.record.orders, cancelRate: data.record.cancelRate, inInterval: data.inInterval } } : d));
      setSession({ ...s, decisions, outcomes: [...s.outcomes, data.record] });
      setRun(data);
      setMode('ran');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const p = current?.proposal ?? null;
  const chosen = p?.chosen ?? null;
  const feasible = p ? p.evals.filter((e) => e.feasible) : [];

  // 승격 판정(R13): 칸별 수정률과 구간 포함률. 기준값은 비운 입력 칸.
  const promotion = useMemo(() => {
    const byCell = new Map<string, { n: number; modified: number; withOutcome: number; inInterval: number }>();
    const sched = current ? [current.sb] : [];
    for (const d of session.decisions) {
      const sb = sched.find((s) => s.id === d.broadcastId);
      const key = sb ? `${sb.category}|${sb.daypart}` : session.outcomes.find((o) => o.id === d.broadcastId) ? `${session.outcomes.find((o) => o.id === d.broadcastId)!.category}|${session.outcomes.find((o) => o.id === d.broadcastId)!.daypart}` : '?';
      const row = byCell.get(key) ?? { n: 0, modified: 0, withOutcome: 0, inInterval: 0 };
      row.n += 1;
      if (d.status === 'modified') row.modified += 1;
      if (d.outcome) {
        row.withOutcome += 1;
        if (d.outcome.inInterval) row.inInterval += 1;
      }
      byCell.set(key, row);
    }
    return [...byCell.entries()];
  }, [session, current]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 text-[14px] text-gray-900">
      <div className="mb-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-rose-900">
        <Badge kind="합성" /> 이 화면의 모든 방송, 상품, 실적은 합성 데이터입니다. 실제 홈쇼핑 수치와 무관하고, 담당자의 수정과 이유는 시연을 위한 시나리오 대본입니다. 합성 결과를 실제 성과로 읽지 마십시오.
      </div>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold">프로모션 조건 결정 에이전트</h1>
          <p className="text-gray-600">편성표의 방송마다 에이전트가 조건 결정안을 올리고, 담당자는 승인하거나 고치고, 고친 이유를 제약으로 배우고, 방송 실적으로 추정을 갱신해 다음 결정안을 냅니다.</p>
        </div>
        <div className="flex gap-2">
          {(['loop', 'ledger', 'promotion'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded px-3 py-1 ${tab === t ? 'bg-gray-900 text-white' : 'bg-gray-100'}`}>
              {{ loop: '결정 고리', ledger: '제약 장부와 결정 기록', promotion: '승격 판정' }[t]}
            </button>
          ))}
          <button onClick={reset} className="rounded border px-3 py-1">
            처음부터
          </button>
        </div>
      </header>

      {error && <div className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-red-800">오류: {error}</div>}
      {busy && <div className="mb-3 rounded bg-gray-100 px-3 py-2 text-gray-700">{busy}...</div>}

      {tab === 'loop' && (
        <div className="grid gap-4 md:grid-cols-[220px_1fr]">
          <aside className="rounded border border-gray-200 p-3">
            <div className="mb-2 font-semibold">편성표 (합성)</div>
            <ol className="space-y-1">
              {Array.from({ length: SCHEDULE_LENGTH }, (_, i) => {
                const id = `S${String(360 + i).padStart(4, '0')}`;
                const done = doneIds.has(id);
                const isCur = current?.sb.id === id;
                const dec = session.decisions.find((d) => d.broadcastId === id);
                return (
                  <li key={id} className={`rounded px-2 py-1 ${isCur ? 'bg-gray-900 text-white' : done ? 'text-gray-400' : ''}`}>
                    {i + 1}. {id} {done ? '방송 완료' : isCur ? '결정 중' : '대기'}
                    {dec && <span className="ml-1 text-[11px]">{dec.status === 'modified' ? '(수정)' : '(승인)'}</span>}
                  </li>
                );
              })}
            </ol>
            <p className="mt-3 text-[12px] text-gray-500">
              반영한 실적 {session.outcomes.length}건, 활성 제약 {session.ledger.filter((c) => c.status === 'active').length}개
            </p>
          </aside>

          <section className="space-y-4">
            {current && p && chosen && (
              <div className="rounded border border-gray-200 p-4">
                <div className="mb-1 text-[12px] text-gray-500">
                  방송 {current.sb.id} (t={current.sb.t}) {current.sb.category} {current.sb.daypart} {current.product.name} 정가 {won(current.product.listPrice)} 마진율 {Math.round(current.product.marginRate * 100)}% <Badge kind="가정" /> 예산 {won(current.sb.budget)} 목표 {p.objective === 'margin' ? '마진' : '매출'}
                </div>
                <h2 className="text-lg font-bold">
                  결정안: {comboLabel(chosen.combo, gifts)}{' '}
                  <span className="text-sm font-normal text-gray-600">
                    실행 가능 {p.feasibleCount}/{p.evals.length} 조합 중 1위, 가장 나을 확률 {Math.round(chosen.pBest * 100)}% <Badge kind="계산" />
                  </span>
                </h2>
                {current.before && current.before.chosen && !sameCombo(current.before.chosen.combo, chosen.combo) && (
                  <div className="mt-1 rounded bg-emerald-50 px-2 py-1 text-emerald-900">직전 실적을 반영하기 전에는 {comboLabel(current.before.chosen.combo, gifts)}이(가) 1위였습니다. 갱신으로 결정안이 바뀌었습니다.</div>
                )}
                {current.before && current.before.chosen && sameCombo(current.before.chosen.combo, chosen.combo) && <div className="mt-1 text-[12px] text-gray-500">직전 실적을 반영해도 1위 조합은 같습니다. 아래 표의 순위와 숫자는 달라졌을 수 있습니다.</div>}

                <table className="mt-3 w-full text-[13px]">
                  <thead>
                    <tr className="text-gray-500">
                      <th className="text-left font-normal"></th>
                      <th className="text-right font-normal">비관(10%)</th>
                      <th className="text-right font-normal">기준(중앙)</th>
                      <th className="text-right font-normal">낙관(90%)</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    <IntervalRow label="주문 수" iv={chosen.orders} badge="추정" />
                    <IntervalRow label="매출(취소 반영)" iv={chosen.revenue} badge="계산" money />
                    <IntervalRow label="프로모션 비용" iv={chosen.promoCost} badge="계산" money />
                    <IntervalRow label="마진" iv={chosen.margin} badge="계산" money />
                  </tbody>
                </table>
                <p className="mt-1 text-[12px] text-gray-500">
                  <Badge kind="추정" /> 과거 합성 방송 {p.cellSamples}건(이 상품군 x 시간대)에서 추정. <Badge kind="계산" /> 추정 주문 수에 가격식을 적용. <Badge kind="가정" /> 취소율 8%, 카드 청구할인 회사 부담 50%, 사은품 원가는 메뉴 입력값. 적용된 제약 {p.appliedConstraintIds.length}개.
                  {p.releasedConstraintId && <span className="text-amber-700"> 모든 조합이 막혀 제약 {p.releasedConstraintId}을(를) 풀었습니다.</span>}
                </p>

                <div className="mt-3 rounded bg-gray-50 p-3">
                  <div className="mb-1 flex items-center gap-2 text-[12px] text-gray-500">
                    에이전트 설명 <Badge kind={current.explanation.source === 'model' ? '모델 문장' : '템플릿'} />
                    {current.explanation.source === 'model' && current.explanation.rejected.length > 0 && <span>검증기가 {current.explanation.rejected.length}번 돌려보낸 뒤 통과</span>}
                    {current.llmNote && <span>{current.llmNote}</span>}
                  </div>
                  <p>{current.explanation.filled.why}</p>
                  {current.explanation.filled.alternatives.map((a, i) => (
                    <p key={i} className="mt-1 text-gray-700">
                      대안 {i + 1}. {a}
                    </p>
                  ))}
                  {current.explanation.filled.caution && <p className="mt-1 text-amber-800">확신이 낮은 곳: {current.explanation.filled.caution}</p>}
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <div className="mb-1 font-semibold">버린 대안</div>
                    {p.alternatives.map((a) => (
                      <div key={a.eval.key} className="mb-1 rounded border border-gray-200 px-2 py-1">
                        <div>
                          {comboLabel(a.eval.combo, gifts)} <span className="text-gray-500">마진 중앙 {won(a.eval.margin.p50)}, 확률 {Math.round(a.eval.pBest * 100)}%</span>
                        </div>
                        <div className="text-[12px] text-gray-600">{a.whyNot.join(' / ')}</div>
                      </div>
                    ))}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold">확신이 낮은 지점</div>
                    {p.lowConfidence.length === 0 && <div className="text-gray-500">없음</div>}
                    {p.lowConfidence.map((l) => (
                      <div key={l.code} className="text-amber-800">
                        {l.detail}
                      </div>
                    ))}
                  </div>
                </div>

                {mode === 'review' && (
                  <div className="mt-4 flex gap-2">
                    <button onClick={approve} className="rounded bg-gray-900 px-4 py-2 text-white">
                      승인
                    </button>
                    <button
                      onClick={() => {
                        setMode('modify');
                        setPickedCombo(chosen.combo);
                      }}
                      className="rounded border px-4 py-2"
                    >
                      고치기
                    </button>
                  </div>
                )}

                {mode === 'modify' && (
                  <div className="mt-4 rounded border border-gray-300 p-3">
                    <div className="mb-2 font-semibold">담당자 수정 (시나리오 대본)</div>
                    <label className="block text-[12px] text-gray-600">조합 선택 (실행 가능한 조합만)</label>
                    <select className="mb-2 w-full rounded border px-2 py-1" value={pickedCombo ? `${pickedCombo.cardLevel}|${pickedCombo.giftId}` : ''} onChange={(e) => { const [l, g] = e.target.value.split('|'); setPickedCombo({ cardLevel: Number(l) as Combo['cardLevel'], giftId: g as Combo['giftId'] }); }}>
                      {feasible.map((e: ComboEval) => (
                        <option key={e.key} value={`${e.combo.cardLevel}|${e.combo.giftId}`}>
                          {e.rank}위 {comboLabel(e.combo, gifts)} 마진 중앙 {won(e.margin.p50)}
                        </option>
                      ))}
                    </select>
                    <div className="mb-1 text-[12px] text-gray-600">이유 (선택지는 예시이며 현업 확인 전)</div>
                    <div className="mb-2 flex flex-wrap gap-1">
                      {CHIPS.map((c) => (
                        <button key={c} onClick={() => setChips(chips.includes(c) ? chips.filter((x) => x !== c) : [...chips, c])} className={`rounded-full border px-2 py-0.5 text-[12px] ${chips.includes(c) ? 'bg-gray-900 text-white' : ''}`}>
                          {c}
                        </button>
                      ))}
                    </div>
                    <textarea className="w-full rounded border px-2 py-1" rows={2} placeholder="자유 문장 (선택). 예: 이 상품군은 체험 구성품이 안 맞아요. 이번만 빼 주세요." value={reasonText} onChange={(e) => setReasonText(e.target.value)} />
                    <div className="mt-2 flex flex-wrap gap-2">
                      {reasonText.trim() && !interp && (
                        <button onClick={interpret} className="rounded border px-3 py-1">
                          에이전트에게 이유 해석시키기
                        </button>
                      )}
                      <button onClick={() => confirmModify(false)} className="rounded bg-gray-900 px-3 py-1 text-white">
                        {reasonText.trim() && !interp ? '해석 없이 수정 확정' : '수정 확정'}
                      </button>
                      <button onClick={() => setMode('review')} className="rounded border px-3 py-1">
                        취소
                      </button>
                    </div>
                    {interp && (
                      <div className={`mt-3 rounded p-3 ${interp.ok ? 'bg-violet-50' : 'bg-amber-50'}`}>
                        {interp.ok && interp.candidate && (
                          <>
                            <div className="font-semibold">이렇게 이해했습니다 <Badge kind="모델 문장" /> (시도 {interp.attempts}회)</div>
                            <div className="mt-1">{interp.description}</div>
                            <div className="text-[12px] text-gray-600">근거 구절: &quot;{interp.candidate.quote}&quot; / 확신 {interp.candidate.confidence === 'high' ? '높음' : '낮음'}</div>
                            <div className="mt-2 flex gap-2">
                              {interp.candidate.kind !== 'unclear' && interp.candidate.kind !== 'note' && (
                                <button onClick={() => confirmModify(true)} className="rounded bg-violet-700 px-3 py-1 text-white">
                                  맞음, 제약으로 등록하고 수정 확정
                                </button>
                              )}
                              {interp.candidate.kind === 'note' && (
                                <button onClick={() => confirmModify(true)} className="rounded bg-violet-700 px-3 py-1 text-white">
                                  메모로 저장하고 수정 확정
                                </button>
                              )}
                              <button onClick={() => confirmModify(false)} className="rounded border px-3 py-1">
                                아님, 제약 없이 수정만
                              </button>
                            </div>
                          </>
                        )}
                        {!interp.ok && (
                          <>
                            <div className="font-semibold">해석하지 못했습니다. 제약을 만들지 않습니다.</div>
                            <div className="text-[12px] text-gray-600">{(interp.errors ?? []).join(' / ')}</div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {mode === 'decided' && finalCombo && (
                  <div className="mt-4 rounded border border-gray-300 p-3">
                    <div>
                      확정: {comboLabel(finalCombo, gifts)} {sameCombo(finalCombo, chosen.combo) ? '(에이전트 원안 승인)' : '(담당자 수정)'}
                    </div>
                    <button onClick={runBroadcast} className="mt-2 rounded bg-gray-900 px-4 py-2 text-white">
                      합성 방송 실행
                    </button>
                  </div>
                )}

                {mode === 'ran' && run && finalCombo && (
                  <div className="mt-4 rounded border border-gray-300 p-3">
                    <div className="font-semibold">방송 후</div>
                    <div className="mt-1">
                      실제 주문 {run.record.orders}건 <Badge kind="합성" /> {run.inInterval ? '예상 구간 안' : '예상 구간 밖'} (취소율 {Math.round(run.record.cancelRate * 100)}%)
                    </div>
                    <div className="mt-2 text-[12px] text-gray-600">이번 실적 한 건이 이 칸의 조합별 예상 주문 수를 얼마나 움직였나 (갱신 전 대비)</div>
                    <table className="mt-1 w-full text-[13px]">
                      <tbody>
                        {run.shifts.map((s) => (
                          <tr key={`${s.combo.cardLevel}|${s.combo.giftId}`} className="border-t border-gray-200">
                            <td className="py-1">{comboLabel(s.combo, gifts)}</td>
                            <td className="py-1 text-right tabular-nums">{Math.round(Math.exp(s.beforeMu) - 1)}건</td>
                            <td className="py-1 text-center">→</td>
                            <td className="py-1 text-right tabular-nums">{Math.round(Math.exp(s.afterMu) - 1)}건</td>
                            <td className={`py-1 text-right tabular-nums ${s.deltaPct > 0 ? 'text-emerald-700' : s.deltaPct < 0 ? 'text-rose-700' : ''}`}>
                              {s.deltaPct >= 0 ? '+' : ''}
                              {s.deltaPct.toFixed(1)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-1 text-[12px] text-gray-500">예측이 얼마나 맞았는지만 말합니다. 이 조건이 매출을 올렸다고 단정하지 않습니다(시간대, 상품군, 기록되지 않는 요인이 함께 움직입니다).</p>
                    {nextIndex < SCHEDULE_LENGTH ? (
                      <button onClick={() => propose(session, nextIndex, true)} className="mt-3 rounded bg-gray-900 px-4 py-2 text-white">
                        다음 방송 결정안
                      </button>
                    ) : (
                      <div className="mt-3 text-gray-700">편성표의 방송을 모두 돌렸습니다. 「처음부터」로 다시 시작할 수 있습니다.</div>
                    )}
                  </div>
                )}
              </div>
            )}
            {current && p && !chosen && <div className="rounded border p-4">실행 가능한 조합이 없습니다. 예산이나 마진 하한, 제약을 확인하십시오.</div>}
          </section>
        </div>
      )}

      {tab === 'ledger' && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded border border-gray-200 p-3">
            <div className="mb-2 font-semibold">제약 장부 (추가 전용)</div>
            {session.ledger.length === 0 && <div className="text-gray-500">아직 없음. 결정안을 고치며 이유를 쓰면 에이전트가 제약 후보로 해석하고, 담당자가 확인하면 여기 쌓입니다.</div>}
            {session.ledger.map((c) => (
              <div key={c.id} className="mb-2 rounded border border-gray-200 px-2 py-1">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {c.id} {c.kind === 'ban_gift' ? '사은품 금지' : c.kind === 'cap_card' ? '카드 상한' : c.kind === 'require_gift' ? '사은품 필수' : c.kind === 'note' ? '메모' : '해석 불가'} {c.status === 'active' ? '(활성)' : c.status === 'released' ? '(해제)' : '(후보)'}
                  </span>
                  {c.status === 'active' && (
                    <button onClick={() => setSession({ ...session, ledger: session.ledger.map((x) => (x.id === c.id ? { ...x, status: 'released' } : x)) })} className="rounded border px-2 py-0.5 text-[12px]">
                      해제
                    </button>
                  )}
                </div>
                <div className="text-[12px] text-gray-600">
                  범위 {[c.scope.productId, c.scope.category, c.scope.daypart].filter(Boolean).join(', ') || '없음'} / 대상 {c.target.giftId ?? (c.target.maxCardLevel !== undefined ? `카드 최대 ${c.target.maxCardLevel}%` : '없음')} / 지속 {c.duration.type === 'this_broadcast' ? `방송 ${c.duration.broadcastId}만` : c.duration.type === 'until_t' ? `t=${c.duration.t} 까지` : '계속'}
                </div>
                <div className="text-[12px] text-gray-500">원문: &quot;{c.sourceText}&quot; / 인용: &quot;{c.quote}&quot;</div>
              </div>
            ))}
          </div>
          <div className="rounded border border-gray-200 p-3">
            <div className="mb-2 font-semibold">결정 기록</div>
            {session.decisions.length === 0 && <div className="text-gray-500">아직 없음</div>}
            <table className="w-full text-[13px]">
              <tbody>
                {session.decisions.map((d) => (
                  <tr key={d.broadcastId} className="border-t border-gray-200">
                    <td className="py-1">{d.broadcastId}</td>
                    <td className="py-1">{d.status === 'modified' ? '수정' : '승인'}</td>
                    <td className="py-1 text-[12px] text-gray-600">
                      원안 카드 {d.proposed.cardLevel}%+{d.proposed.giftId} → 최종 카드 {d.final.cardLevel}%+{d.final.giftId}
                    </td>
                    <td className="py-1 text-[12px] text-gray-600">{d.outcome ? `${d.outcome.orders}건 ${d.outcome.inInterval ? '구간 안' : '구간 밖'}` : '방송 전'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'promotion' && (
        <div className="rounded border border-gray-200 p-3">
          <div className="mb-1 font-semibold">승격 판정 (단계적 위임의 설계 표시)</div>
          <p className="mb-2 text-[12px] text-gray-600">시제품의 권한은 「에이전트가 정하고 담당자가 승인」입니다. 아래는 상품군 x 시간대 칸별로 에이전트의 예측 품질(담당자 수정률, 예상 구간 포함률)을 계산해 보여 줍니다. 승격 기준값은 현업이 정하는 칸이라 비워 두었고, 자동 확정은 구현하지 않았습니다. 현실에서는 원안과 수정안 중 어느 쪽이 더 맞았는지를 직접 잴 수 없습니다(한쪽만 방송되므로).</p>
          <div className="mb-2 flex gap-2 text-[12px]">
            <label>
              수정률 기준(%) <input className="w-16 rounded border px-1" placeholder="현업 입력" disabled />
            </label>
            <label>
              구간 포함률 기준(%) <input className="w-16 rounded border px-1" placeholder="현업 입력" disabled />
            </label>
          </div>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="font-normal">칸</th>
                <th className="font-normal">결정 수</th>
                <th className="font-normal">수정률</th>
                <th className="font-normal">구간 포함률</th>
                <th className="font-normal">판정</th>
              </tr>
            </thead>
            <tbody>
              {promotion.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-2 text-gray-500">
                    결정 기록이 쌓이면 표시됩니다.
                  </td>
                </tr>
              )}
              {promotion.map(([cell, r]) => (
                <tr key={cell} className="border-t border-gray-200">
                  <td className="py-1">{cell}</td>
                  <td className="py-1">{r.n}</td>
                  <td className="py-1">{Math.round((r.modified / r.n) * 100)}%</td>
                  <td className="py-1">{r.withOutcome ? `${Math.round((r.inInterval / r.withOutcome) * 100)}%` : '방송 전'}</td>
                  <td className="py-1 text-gray-500">기준값 미입력</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="mt-8 text-[12px] text-gray-500">숫자와 순위는 전부 코드가 계산합니다. 모델은 결정안 문장(슬롯만)과 수정 이유 해석에만 쓰입니다. 구현은 AI 에이전트(Claude Code), 문제 정의와 판단은 김지은.</footer>
    </main>
  );
}
