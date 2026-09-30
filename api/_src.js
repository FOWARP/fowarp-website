// 유입 경로를 사람 말로 바꾸는 규칙 — 방문 알림(visit.js)과 문의 메일(contact.js)이 같이 쓴다.

/** 유입 경로를 사람 말로. 검색어가 붙어 오면 그것까지. */
/**
 * 앱 안에서 링크를 열면(인스타·카톡 등) referrer 가 대부분 비어서 '직접 입력'
 * 으로 잡힌다. 인앱 브라우저는 User-Agent 에 자기 이름을 박아두므로 그걸로
 * 되살린다. 한국 유입은 카톡·인스타 공유가 큰 비중이라 이게 없으면 통계가
 * 통째로 왜곡된다.
 */
function inAppSource(ua) {
  if (!ua) return null;
  if (/Instagram/i.test(ua)) return '인스타그램 앱';
  if (/Threads|Barcelona/i.test(ua)) return '스레드 앱';
  if (/KAKAOTALK/i.test(ua)) return '카카오톡';
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return '페이스북 앱';
  if (/NAVER\(inapp/i.test(ua)) return '네이버 앱';
  if (/DaumApps/i.test(ua)) return '다음 앱';
  if (/Line\//i.test(ua)) return '라인';
  if (/TwitterAndroid|Twitter for/i.test(ua)) return '트위터 앱';
  if (/everytimeApp/i.test(ua)) return '에브리타임';
  return null;
}

function referrerLabel(ref, ua) {
  if (!ref) return inAppSource(ua) || '직접 입력·북마크';
  let host;
  try { host = new URL(ref).hostname.replace(/^www\./, ''); } catch { return '알 수 없음'; }
  if (/fowarp/.test(host)) return null; // 사이트 내부 이동
  const known = {
    'google.com': '구글 검색', 'google.co.kr': '구글 검색',
    'search.naver.com': '네이버 검색', 'naver.com': '네이버',
    'daum.net': '다음', 'search.daum.net': '다음 검색',
    'bing.com': '빙 검색', 'instagram.com': '인스타그램',
    'l.instagram.com': '인스타그램', 'behance.net': 'Behance',
    'linkedin.com': '링크드인', 'facebook.com': '페이스북',
    't.co': '트위터', 'youtube.com': '유튜브',
  };
  if (known[host]) return known[host];
  // 모바일·지역 서브도메인(m.search.naver.com, m.facebook.com, google.co.jp …)이
  // 호스트 이름 그대로 찍혀 같은 유입이 여러 줄로 갈라지던 것을 묶는다.
  if (/(^|\.)search\.naver\.com$/.test(host)) return '네이버 검색';
  if (/(^|\.)blog\.naver\.com$/.test(host)) return '네이버 블로그';
  if (/(^|\.)naver\.com$/.test(host)) return '네이버';
  if (/(^|\.)search\.daum\.net$/.test(host)) return '다음 검색';
  if (/(^|\.)daum\.net$/.test(host)) return '다음';
  if (/^google\.[a-z.]+$/.test(host)) return '구글 검색';
  if (/(^|\.)instagram\.com$/.test(host)) return '인스타그램';
  if (/(^|\.)facebook\.com$/.test(host)) return '페이스북';
  if (/(^|\.)bing\.com$/.test(host)) return '빙 검색';
  return host;
}

/**
 * 광고·꼬리표 링크 정보(js/track.js 가 URL 에서 읽어 보낸 것)를 사람 말로.
 * 광고 클릭도 referrer 만 보면 그냥 '네이버 검색'이라 일반 검색과 섞인다.
 *   { ad: 'naver', kw: '식품 패키지 디자인' } → { label: '네이버 광고', kw }
 *   { tag: 'behance' }                         → { label: 'behance 링크' }
 * 클라이언트가 보낸 값이라 길이·문자를 잘라서 쓴다. 없거나 이상하면 null.
 */
const clean = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : '');
const AD_NAMES = {
  naver: '네이버 광고', google: '구글 광고', kakao: '카카오 광고', daum: '카카오 광고',
  instagram: '인스타 광고', ig: '인스타 광고', meta: '인스타 광고', facebook: '인스타 광고', fb: '인스타 광고',
};
function adLabel(t) {
  if (!t || typeof t !== 'object') return null;
  const kw = clean(t.kw, 60) || null;
  const camp = clean(t.camp, 60) || null;
  const ad = clean(t.ad, 30).toLowerCase();
  if (ad) return { label: AD_NAMES[ad] || `${ad} 광고`, kw, camp, paid: true };
  const tag = clean(t.tag, 30);
  if (tag) return { label: `${tag} 링크`, kw, camp, paid: false };
  return null;
}

module.exports = { referrerLabel, inAppSource, adLabel };
