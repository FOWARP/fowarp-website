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

  // 내 기기 제외 — fowarp.com/?mute 로 한 번 들어가면 그 브라우저는
  // 이후 알림을 만들지 않는다(?unmute 로 해제). 오누리가 사이트를 확인할
  // 때마다 자기 방문 알림이 오는 걸 막는 용도. 기기·브라우저마다 한 번씩.
  try {
    if (/[?&]unmute/.test(location.search)) localStorage.removeItem('fw_mute');
    else if (/[?&]mute/.test(location.search)) localStorage.setItem('fw_mute', '1');
    if (localStorage.getItem('fw_mute')) return;
  } catch (e) {}

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

  // ── 컨택트 폼 이탈 감지 ────────────────────────────
  // 문의를 쓰다 만 사람은 '놓친 리드'라 따로 센다. 입력을 한 글자라도 했는데
  // 완료 화면(.contact.is-done)에 도달하지 못한 채 떠나면 이탈로 본다.
  // 단계마다 input 요소가 교체되므로 개별 바인딩 대신 위임으로 듣는다.
  var formTouched = false;
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'stepInput' && e.target.value) formTouched = true;
  }, true);
  function formAbandoned() {
    return formTouched && !document.querySelector('.contact.is-done');
  }

  // ── 사이트 안에서의 이동은 '이탈'이 아니다 ──────────
  // 페이지를 옮길 때도 pagehide 가 뜨기 때문에, 그대로 두면 컨택트 페이지로
  // 넘어가는 순간 "방문 종료" 알림이 나간다. 이동을 유발하는 클릭을 미리
  // 잡아 두고 그때는 2차 알림을 보내지 않는다.
  var navigating = false;
  function markNav() {
    navigating = true;
    // 클릭했는데 실제로는 안 옮겨간 경우(preventDefault 등) 진짜 이탈까지
    // 막아버리지 않도록 되돌린다. 실제로 이동하면 이 타이머째 사라진다.
    setTimeout(function () { navigating = false; }, 3000);
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[href]');
    if (a) {
      var u;
      try { u = new URL(a.getAttribute('href'), location.href); } catch (err) { return; }
      // 새 탭으로 열리는 링크는 이 페이지를 떠나는 게 아니다
      if (u.host === location.host && a.target !== '_blank') markNav();
      return;
    }
    // Get in Touch 는 a 가 아니라 span + location.href 라 따로 잡는다
    if (t.closest('.header-cta')) markNav();
  }, true);

  // ── 2차: 탭을 닫거나 백그라운드로 보낼 때 요약 ──────
  var sent = false;
  function leave() {
    if (sent || navigating) return;
    var cur = read(sessionStorage, SS) || s;
    var dwell = Math.round((Date.now() - cur.start) / 1000);
    // 예전에는 여기서 30초 미만을 잘라 트래픽을 아꼈지만, 그러면 하루 요약의
    // 방문 수·컨택트 지표에서 짧은 방문이 통째로 빠진다. 서버가 알림만 거른다.
    sent = true;
    post({ phase: 'leave', path: path, dwell: dwell, pages: cur.pages,
           formAbandon: formAbandoned() }, true);
  }

  // pagehide 가 iOS 사파리에서 가장 확실하다(unload 는 안 불릴 때가 있다)
  addEventListener('pagehide', leave);
  // visibilitychange 는 document 에서 발생한다 — window 에 걸면 놓친다
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') leave();
  });
})();
