// 방문 알림용 추적 — 오누리 폰으로 푸시를 보내기 위한 최소 정보만 모은다.
//
// 방문자 식별·카운트는 전부 이 브라우저의 localStorage 안에서 끝난다.
// 서버로는 "몇 번째 방문인지" 같은 결과값만 실어 보내고, 서버는 그걸
// 저장하지 않는다(쿠키·DB 없음).
//
// 봇은 대부분 JS 를 실행하지 않아 여기까지 오지 않는다. 서버에서 UA 와
// 데이터센터 IP 를 한 번 더 거른다.
(function () {
  'use strict';

  // 로컬 개발 중에는 알림을 보내지 않는다
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;

  var LS = 'fw_visit';
  var SS = 'fw_session';
  var COOLDOWN = 30 * 60 * 1000; // 같은 방문자는 30분에 한 번만 1차 알림

  function read(store, key) {
    try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function write(store, key, val) {
    try { store.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  var now = Date.now();
  var path = location.pathname.replace(/\/$/, '') || '/';
  var isMobile = matchMedia('(max-width: 767px)').matches ||
                 /iphone|ipad|android|mobile/i.test(navigator.userAgent);

  // ── 방문자 기록(영속) ──────────────────────────────
  var v = read(localStorage, LS) || { visits: 0, last: null };

  // ── 세션(탭 단위) ──────────────────────────────────
  var s = read(sessionStorage, SS);
  var isNewSession = !s || (now - s.start) > COOLDOWN;

  if (isNewSession) {
    v.visits = (v.visits || 0) + 1;
    s = { sid: String(now) + Math.random().toString(36).slice(2, 6), start: now, pages: [] };
  }

  if (s.pages[s.pages.length - 1] !== path) s.pages.push(path);
  write(sessionStorage, SS, s);

  var prevLast = v.last;
  v.last = now;
  write(localStorage, LS, v);

  function post(payload, useBeacon) {
    payload.sid = s.sid;
    payload.mobile = isMobile;
    var body = JSON.stringify(payload);
    // 페이지를 떠나는 중에는 fetch 가 취소될 수 있어 sendBeacon 을 쓴다
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/visit', new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch('/api/visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true,
    }).catch(function () {});
  }

  // ── 1차: 접속 즉시 (세션 시작일 때만) ───────────────
  if (isNewSession) {
    post({
      phase: 'enter',
      path: path,
      referrer: document.referrer || '',
      visits: v.visits,
      lastVisit: prevLast,
    });
  }

  // ── 2차: 탭을 닫거나 백그라운드로 보낼 때 요약 ──────
  var sent = false;
  function leave() {
    if (sent) return;
    var cur = read(sessionStorage, SS) || s;
    var dwell = Math.round((Date.now() - cur.start) / 1000);
    if (dwell < 30) return;   // 서버에서도 한 번 더 거르지만 트래픽을 아낀다
    sent = true;
    post({ phase: 'leave', path: path, dwell: dwell, pages: cur.pages }, true);
  }

  // pagehide 가 iOS 사파리에서 가장 확실하다(unload 는 안 불릴 때가 있다)
  addEventListener('pagehide', leave);
  // visibilitychange 는 document 에서 발생한다 — window 에 걸면 놓친다
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') leave();
  });
})();
