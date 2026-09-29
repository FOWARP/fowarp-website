// 하루 요약용 집계 저장소 (Upstash Redis, REST API)
//
// 개별 방문 알림은 여전히 서버에 아무것도 저장하지 않는다. 여기 쌓는 건
// "오늘 몇 명, 어느 페이지, 어디서 유입" 같은 숫자뿐이고 개인을 식별할 수
// 있는 값은 넣지 않는다(IP·UA 저장 안 함). 방문자 구분은 클라이언트가 만든
// 임시 세션 id 로만 하고 그것도 8일 뒤 자동 삭제된다.
//
// REST API 라 SDK 가 필요 없어 이 저장소의 '의존성 0개' 원칙이 유지된다.
//
// 환경변수 (Vercel 마켓플레이스에서 Upstash 연동 시 자동 주입):
//   KV_REST_API_URL / KV_REST_API_TOKEN
// Vercel 이 Upstash 를 붙일 때 UPSTASH_* 가 아니라 KV_* 이름으로 넣어준다.
// 예전 이름도 함께 읽어 두 경우 모두 동작하게 한다.

const TTL = 60 * 60 * 24 * 8; // 8일 — 주간 비교까지만 보관

/** 오늘 날짜(한국 기준). Vercel 함수는 UTC 로 도니 직접 보정한다. */
function todayKST(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

const REST_URL = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

function configured() {
  return !!(REST_URL() && REST_TOKEN());
}

/** 여러 명령을 한 번의 왕복으로. 실패해도 조용히 넘어간다(집계는 부가 기능). */
async function pipeline(cmds) {
  if (!configured() || !cmds.length) return null;
  try {
    const r = await fetch(REST_URL() + '/pipeline', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + REST_TOKEN(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

const K = {
  count: (d) => `st:${d}:c`,      // 해시 — 방문/체류 등 단순 카운터
  sids: (d) => `st:${d}:s`,       // 셋   — 고유 방문자(세션 id)
  pages: (d) => `st:${d}:p`,      // 해시 — 페이지별 조회수
  refs: (d) => `st:${d}:r`,       // 해시 — 유입 경로별
  cfrom: (d) => `st:${d}:cf`,     // 해시 — 컨택트 직전에 본 페이지 (예전 방식, 읽기만)
  sess: (d) => `st:${d}:ss`,      // 해시 — 세션 id → 그 세션의 마지막 상태(JSON)
};

/** 방문 1건 기록 (enter) */
function recordEnter({ sid, page, ref, returning }) {
  const d = todayKST();
  const c = [
    ['HINCRBY', K.count(d), 'visits', 1],
    ['HINCRBY', K.count(d), returning ? 'returning' : 'first', 1],
    ['EXPIRE', K.count(d), TTL],
  ];
  if (sid) c.push(['SADD', K.sids(d), sid], ['EXPIRE', K.sids(d), TTL]);
  if (page) c.push(['HINCRBY', K.pages(d), page, 1], ['EXPIRE', K.pages(d), TTL]);
  if (ref) c.push(['HINCRBY', K.refs(d), ref, 1], ['EXPIRE', K.refs(d), TTL]);
  return pipeline(c);
}

/**
 * 방문 종료 기록 (leave) — 세션마다 '마지막 상태'를 덮어쓴다.
 *
 * 예전에는 leave 가 올 때마다 체류시간·페이지를 더했다. 그런데 폰에서 앱을
 * 잠깐 전환하거나 뒤로가기로 이동하면 한 방문에서 leave 가 여러 번 와서
 * 세션 수와 체류시간이 부풀었다. 이제는 세션 id 하나에 값 하나만 두고
 * 합계는 읽을 때(readDay) 계산한다. 몇 번이 오든 마지막 값만 남는다.
 */
function recordLeave({ sid, dwell, pages, formAbandon }) {
  if (!sid) return null;
  const d = todayKST();
  const v = JSON.stringify({
    t: Math.round(dwell) || 0,
    p: (pages || []).slice(0, 30),
    f: formAbandon ? 1 : 0,
  });
  return pipeline([
    ['HSET', K.sess(d), sid, v],
    ['EXPIRE', K.sess(d), TTL],
  ]);
}

/**
 * key 가 처음이면 true. ttl 동안은 false.
 * 같은 경보를 하루에 한 번만 보내는 용도. 저장소가 없거나 실패하면 false
 * (중복 발송보다 안 보내는 쪽이 낫다).
 */
async function once(key, ttl) {
  const r = await pipeline([['SET', key, '1', 'NX', 'EX', ttl]]);
  return !!(r && r[0] && r[0].result === 'OK');
}

/** 문의 폼 실제 제출 (api/contact.js 에서 호출) */
function recordSubmit() {
  const d = todayKST();
  return pipeline([
    ['HINCRBY', K.count(d), 'submits', 1],
    ['EXPIRE', K.count(d), TTL],
  ]);
}

/** 하루치 집계 읽기 */
async function readDay(d) {
  const res = await pipeline([
    ['HGETALL', K.count(d)],
    ['SCARD', K.sids(d)],
    ['HGETALL', K.pages(d)],
    ['HGETALL', K.refs(d)],
    ['HGETALL', K.cfrom(d)],
    ['HGETALL', K.sess(d)],
  ]);
  if (!res) return null;
  const val = (i) => (res[i] && res[i].result) || null;

  // Upstash 는 HGETALL 을 [k,v,k,v...] 배열로 준다
  const toObj = (arr) => {
    const o = {};
    if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) o[arr[i]] = Number(arr[i + 1]) || 0;
    else if (arr && typeof arr === 'object') for (const k in arr) o[k] = Number(arr[k]) || 0;
    return o;
  };

  const count = toObj(val(0));
  const pages = toObj(val(2));
  const contactFrom = toObj(val(4));

  // 세션별 마지막 상태를 합친다. 예전 방식으로 쌓인 값(count 의 sessions 등)은
  // 그대로 두고 더하기만 해서, 전환한 날도 숫자가 끊기지 않는다.
  const raw = val(5);
  const list = [];
  if (Array.isArray(raw)) for (let i = 1; i < raw.length; i += 2) list.push(raw[i]);
  else if (raw && typeof raw === 'object') for (const k in raw) list.push(raw[k]);
  const add = (o, k, n) => { o[k] = (Number(o[k]) || 0) + n; };
  for (const item of list) {
    let x;
    try { x = JSON.parse(item); } catch { continue; }
    const seen = Array.isArray(x.p) ? x.p : [];
    add(count, 'sessions', 1);
    add(count, 'dwellSum', Number(x.t) || 0);
    if (x.f) add(count, 'formAbandon', 1);
    // 첫 페이지는 enter 때 이미 셌다
    seen.slice(1).forEach((p) => add(pages, p, 1));
    const ci = seen.findIndex((p) => /^\/contact/.test(p));
    if (ci > -1) {
      add(count, 'contactViews', 1);
      if (ci > 0) add(contactFrom, seen[ci - 1], 1);
    }
  }

  return {
    count,
    uniques: Number(val(1)) || 0,
    pages,
    refs: toObj(val(3)),
    contactFrom,
  };
}

module.exports = { recordEnter, recordLeave, recordSubmit, readDay, todayKST, configured, once };
