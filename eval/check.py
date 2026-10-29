# 평가용 자료 검사. 실행: python3 -I eval/check.py  (promo-agent 폴더 또는 어디서든)
import json, os, re, sys
D = os.path.dirname(os.path.abspath(__file__))
CATS = ['건강식품', '뷰티', '패션', '생활가전', '식품']
DPS = ['아침', '낮', '저녁', '심야']
MIS = ['concaveCard', 'interaction', 'daypartElasticity', 'structuralChange', 'hiddenFactor', 'selectionBias', 'heavyTail']
POL = {'boost-strong', 'rescue-weak', 'random'}
BAD = ['쿠폰', '혜택 부여', '분할결제', '무이자', '·', '—']
errs = []
def e(m): errs.append(m)

W = json.load(open(os.path.join(D, 'worlds.json'), encoding='utf-8'))['worlds']
if len(W) != 48: e(f'세계 수 {len(W)}')
names = [w['name'] for w in W]
if len(set(names)) != 48: e('세계 이름 중복')
for tag, want in (('on', True), ('off', False)):
    ws = [w for w in W if w['name'].endswith('-' + tag)]
    if len(ws) != 24: e(f'{tag} 세계 수 {len(ws)}')
    for w in ws:
        m = w['cfg']['misspec']
        if sorted(m) != sorted(MIS) or any(m[k] is not want for k in MIS): e(f"{w['name']} misspec")
seeds = [w['cfg']['seed'] for w in W if w['name'].endswith('-on')]
if len(set(seeds)) != 24 or 20261030 in seeds: e('시드 중복 또는 개발용 시드')
if sorted(seeds) != sorted(w['cfg']['seed'] for w in W if w['name'].endswith('-off')): e('on/off 시드 불일치')
pc = {}
for w in W:
    c = w['cfg']
    if not (isinstance(c['seed'], int) and 300 <= c['historyLength'] <= 420): e(f"{w['name']} historyLength")
    if not (0.70 <= c['changeAt'] / c['historyLength'] <= 0.85 + 1e-9): e(f"{w['name']} changeAt 비율")
    if not (0.25 <= c['noiseSd'] <= 0.40): e(f"{w['name']} noiseSd")
    if c['policy'] not in POL: e(f"{w['name']} policy")
    pc[c['policy']] = pc.get(c['policy'], 0) + 1
if len(pc) != 3: e(f'정책 혼합 부족 {pc}')

S = json.load(open(os.path.join(D, 'reason-sentences.json'), encoding='utf-8'))['sentences']
dist = {}
ids = [s['id'] for s in S]
if len(S) != 50 or len(set(ids)) != 50: e('문장 수 또는 id 중복')
for s in S:
    i, t, b, x = s['id'], s['text'], s['broadcast'], s['expected']
    dist[x['kind']] = dist.get(x['kind'], 0) + 1
    for bad in BAD:
        if bad in t or bad in x['quote']: e(f'{i} 금지어 {bad}')
    if b['category'] not in CATS or b['daypart'] not in DPS: e(f'{i} 방송 칸')
    if b['id'] != f"S{b['t']:04d}": e(f'{i} 방송 id')
    if not re.fullmatch(r'(건강식품|뷰티|패션|생활가전|식품)-[123]', b['productId']) or not b['productId'].startswith(b['category'] + '-'): e(f'{i} productId')
    if x['quote'] not in t: e(f'{i} quote 가 text 에 없음')
    for n in re.findall(r'\d+', x['quote']):
        if n not in t: e(f'{i} 숫자 {n}')
    g, mx = x['target'].get('giftId'), x['target'].get('maxCardLevel')
    if g is not None and g not in ('A', 'B', 'C'): e(f'{i} giftId {g}')
    if mx is not None and mx not in (0, 5, 7, 10): e(f'{i} maxCardLevel {mx}')
    k = x['kind']
    if k in ('ban_gift', 'require_gift') and g is None: e(f'{i} giftId 필요')
    if k == 'cap_card':
        if mx is None: e(f'{i} maxCardLevel 필요')
        elif mx != 0 and str(mx) not in re.findall(r'\d+', t): e(f'{i} 상한 숫자가 text 에 없음')
    if k in ('note', 'unclear') and x['target']: e(f'{i} {k} 인데 target 있음')
    sc = x['scope']
    if sc.get('category', b['category']) != b['category'] or sc.get('daypart', b['daypart']) != b['daypart'] or sc.get('productId', b['productId']) != b['productId']: e(f'{i} scope 가 방송과 다름')
    d = x['duration']
    if d['type'] == 'this_broadcast' and d['broadcastId'] != b['id']: e(f'{i} duration id')
    if d['type'] == 'until_t' and not (isinstance(d['t'], int) and d['t'] > b['t']): e(f'{i} until_t')
want = {'ban_gift': 14, 'cap_card': 10, 'require_gift': 6, 'note': 10, 'unclear': 10}
if dist != want: e(f'분포 {dist}')
print('오류', len(errs)); [print(' ', m) for m in errs]
print('분포', dist, '정책', pc)
sys.exit(1 if errs else 0)
