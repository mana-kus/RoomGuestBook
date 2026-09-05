/* 동작 전담. 색과 크기, 모션은 style.css 에서만 다룹니다.
   여기서는 <body> 의 ph-* 클래스를 바꿀 뿐이고, 그 결과 보이는 모습은 전부 CSS 가 정합니다. */

// 화면 우측 아래에 찍히는 판 번호. 이 파일을 불러온 <script src="app.js?v=NN"> 에서 읽는다.
// 숫자를 여기와 index.html 양쪽에 적어두면 한쪽만 고치고 넘어가는 사고가 난다.
const VERSION = (() => {
  const m = /[?&]v=([^&]*)/.exec((document.currentScript || {}).src || "");
  return m ? "v" + m[1] : "";
})();

const CLIENT_ID = "60891083163-acnj22k5h7m921srilkdvbi8is0o60sv.apps.googleusercontent.com";
const ENDPOINT  = "https://script.google.com/macros/s/AKfycbxBwVkyj3PLy0nKJmBXPFN-UweRpH99d-p3SbkF1XUQf4pKt086OcXHm1_UCcnA6W-X/exec";

const POS_HELP = {
  denied: "위치 확인이 차단되어 있습니다.",
  unavailable: "위치를 확인할 수 없습니다."
};

const IN_APP = /KAKAOTALK|Instagram|FBAN|FBAV|FB_IAB|Line\/|NAVER|DaumApps|everytime/i
  .test(navigator.userAgent);

// 측위를 기다리는 시간. 권한 팝업을 읽는 시간도 여기 포함된다.
// 실내에서는 10초를 넘기는 일이 드물지 않아 넉넉히 잡는다. 짧게 잡으면 멀쩡한 사람이 실패한다.
const WAIT = 15000;

const $ = id => document.getElementById(id);

let credential = null;
let profile = null;      // 신규 등록 시 함께 보낼 이름과 학번
let phase = "login";
let back = "settled";    // 명단 화면에서 돌아갈 곳
let burst = false;
let blocked = false;
let dup = false;         // 1시간 안에 이미 남긴 경우. 축하 연출을 하지 않는다
let jelly = 0;
let geoCache = null;     // 이름과 학번을 받으러 갔다 오는 동안만 들고 있는 좌표

function payload(jwt) {
  try {
    return JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(String(jwt).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
                      c => c.charCodeAt(0))
    ));
  } catch (e) {
    return {};
  }
}

// 구글 ID 토큰은 한 시간이면 만료된다. 만료된 것을 들고 다시 눌러봐야 서버가 거절할 뿐이고,
// 화면은 같은 실패만 반복해서 빠져나갈 길이 새로고침밖에 없어진다. 누르기 전에 미리 본다.
function expired() {
  const p = payload(credential);
  return !p.exp || p.exp * 1000 <= Date.now();
}

const clock = () => {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
};

const sidOk = () => $("sid").value.length === 10;

function paint() {
  const cls = ["ph-" + phase];
  if (phase === "new" && sidOk()) cls.push("ok");
  if (burst) cls.push("burst-on");
  if (blocked) cls.push("blocked");
  if (dup) cls.push("dup");
  document.body.className = cls.join(" ");
}

// 단계가 바뀔 때마다 버튼을 한 번 출렁이게 한다.
// 같은 애니메이션을 다시 재생시키려고 지연 값을 카운터로 흘린다.
function go(next) {
  phase = next;
  jelly += 1;
  paint();
  $("morph").style.animation = "jelly .72s cubic-bezier(.28,1.3,.4,1) " + jelly + "ms";
}

function say(text) {
  $("status").textContent = text || "";
}

// 실패 판에 들어갈 문자열. 브라우저가 스스로 겪은 것만 쓴다.
// 서버가 돌려준 것은 무엇이든 여기에 옮기지 않는다.
function fail(text) {
  $("failReason").textContent = text || "";
  say("");
  go("failed");
}

// 로그인 화면으로 되돌린다. #gsi 안의 구글 버튼은 그대로 살아 있으므로 다시 누르면 된다.
function relogin(text) {
  credential = null;
  geoCache = null;
  profile = null;
  go("login");
  say(text || "로그인이 만료되었습니다. 다시 로그인해주세요.");
}

// 응답을 받지 못한 것과, 받았는데 거절인 것은 다르다. 앞은 브라우저가 직접 겪은 일이라
// 그대로 알려도 되고, 뒤는 서버 사정이라 알리지 않는다. 그래서 둘을 섞지 않는다.
// 못 받은 경우는 null. 끊겼거나, 오류 코드거나, Apps Script 가 JSON 대신 HTML 을 준 경우다.
async function post(extra) {
  let text;
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ credential: credential }, extra))
    });
    if (!r.ok) return null;
    text = await r.text();
  } catch (e) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// timeout 은 권한 팝업을 띄워둔 시간까지 함께 센다. 처음 오는 사람은 팝업을 읽고
// 누르는 동안 시간이 흐르므로 넉넉히 준다. maximumAge 는 최근에 잡아둔 위치를
// 그대로 쓰게 해서 두 번째부터는 기다림이 없다.
// getCurrentPosition 은 쓸 만한 값 하나를 만들어 주려고 시간을 쓴다.
// watchPosition 은 잡히는 족족 던져주므로 첫 값을 받고 바로 끊는다.
// 정밀한 좌표가 필요한 것이 아니라 대략의 위치면 충분하다.
const getPos = (timeout, gps) => new Promise(done => {
  if (!navigator.geolocation) return done({ error: "unavailable" });

  let id = null;
  let timer = null;
  const finish = v => {
    if (id !== null) navigator.geolocation.clearWatch(id);
    clearTimeout(timer);
    done(v);
  };

  timer = setTimeout(() => finish({ error: "unavailable" }), timeout);
  id = navigator.geolocation.watchPosition(
    p => finish({
      lat: p.coords.latitude,
      lon: p.coords.longitude,
      acc: Math.round(p.coords.accuracy)   // 오차 크기. 좌표가 아니라 측위 상태를 보는 값이다
    }),
    e => { if (e.code === 1) finish({ error: "denied" }); },   // 거부는 즉시, 그 외는 계속 기다린다
    { enableHighAccuracy: !!gps, timeout: timeout, maximumAge: 300000 }
  );
});

// 이미 권한을 허용한 사람은 팝업이 뜨지 않으므로, 페이지가 열리자마자 측위를 시작해
// 로그인하는 동안 끝내둔다. 아직 허락하지 않은 사람에게는 손대지 않는다.
// 로그인도 하기 전에 위치 팝업이 뜨면 당황스럽고, 팝업을 읽는 시간이 timeout 을 잡아먹는다.
let warm = null;
let permission = null;   // "granted" | "prompt" | "denied" | null(알 수 없음)
function warmUp() {
  if (!navigator.permissions || !navigator.geolocation) return;
  navigator.permissions.query({ name: "geolocation" })
    .then(p => {
      permission = p.state;
      p.onchange = () => { permission = p.state; };
      if (p.state === "granted") warm = getPos(WAIT);
    })
    .catch(() => {});
}

// 첫 측위는 콜드 스타트라 한 번에 실패하는 일이 잦다. 미리 시작해 둔 것이 있으면 그 결과를 쓴다.
async function pos() {
  const g = warm ? await warm : await getPos(WAIT);
  warm = null;
  // Wi-Fi 와 기지국 측위를 아예 쓸 수 없는 기기가 있다(설정에서 꺼둔 경우).
  // 그때는 즉시 실패로 돌아오므로, 마지막으로 GPS 로 한 번 더 물어본다.
  // 여기서 한 번 더 기다리게 되는 것은 감수하되, 문구를 바꿔 멈춘 것이 아님을 알린다.
  if (g.error === "unavailable") {
    $("savingLabel").textContent = "위치 다시 확인 중";
    return getPos(WAIT, true);
  }
  return g;
}

// 로그인만 하면 바로 기록한다. 누를 것이 없다.
// 등록된 계정인지는 서버가 이 요청 안에서 판단해 needProfile 로 알려주므로,
// 미리 물어보는 왕복을 따로 두지 않는다.
function onCredential(res) {
  credential = res.credential;
  const p = payload(credential);
  $("meLabel").textContent = (p.name || p.email || "") + " 님으로";
  say("");
  record();
}

async function record() {
  if (!credential || expired()) return relogin();

  go("saving");
  $("savingLabel").textContent = "위치 확인 중";
  say("");

  // 실내에서는 10초를 넘기기도 한다. 아무 변화가 없으면 멈춘 화면으로 보이므로 한 번 갈아준다.
  const slow = setTimeout(() => {
    if (phase === "saving") $("savingLabel").textContent = "위치를 찾는 중입니다";
  }, 6000);

  // 이름과 학번을 받으러 갔다 온 경우에는 이미 잡아둔 좌표가 있다. 다시 재지 않는다.
  const geo = geoCache || await pos();
  clearTimeout(slow);

  if (phase !== "saving") return;   // 기다리는 사이 다른 화면으로 옮겨갔으면 그만둔다
  $("savingLabel").textContent = "기록 중";

  const data = await post(Object.assign({ pos: geo.error ? null : geo }, profile));

  if (!data) {
    geoCache = null;
    return fail("응답을 받을 수 없습니다.");
  }

  if (data.needProfile) {
    geoCache = geo.error ? null : geo;   // 성공한 좌표만 들고 간다
    go("new");
    return;
  }
  geoCache = null;

  if (data.ok === true || data.recent) {
    profile = null;
    const time = clock();
    $("doneTime").textContent = time;
    $("settledTime").textContent = time;
    $("settledLabel").textContent = data.recent ? "이미 기록되어 있습니다" : "완료되었습니다";

    if (data.recent) { dup = true; go("settled"); return; }
    dup = false;

    if (navigator.vibrate) navigator.vibrate(60);
    burst = true;
    go("done");
    setTimeout(() => { burst = false; paint(); }, 1000);
    setTimeout(() => { if (phase === "done") go("settled"); }, 1250);
    return;
  }

  fail(geo.error ? POS_HELP[geo.error] : "지금은 기록할 수 없습니다.");
}

/* ── 입장 기록 ─────────────────────────────────────────────────────
   여기서 보내는 신원은 구글이 서명한 토큰 하나뿐이다. 이름이나 연락처를 따로 싣지 않는다.
   브라우저가 스스로 주장하는 값은 누구든 바꿔 보낼 수 있기 때문이다.
   기록 흐름과는 상태를 공유하지 않는다. 여기서 무엇이 잘못되든 기록은 그대로 동작해야 한다. */

let visitorsBusy = false;

function visitorsShow(node) {
  const body = $("visitorsBody");
  body.textContent = "";
  body.appendChild(node);
}

function visitorsNote(text) {
  const p = document.createElement("p");
  p.className = "visitors-note";
  p.textContent = text;
  return p;
}

// 서버가 준 문자열은 전부 textContent 로만 넣는다. innerHTML 은 쓰지 않는다.
function visitorRow(v) {
  const row = document.createElement("div");
  row.className = "visitor";

  const name = document.createElement("span");
  name.className = "visitor-name";
  const time = document.createElement("span");
  time.className = "visitor-time tnum";

  if (v && typeof v === "object") {
    name.textContent = v.name == null ? "" : String(v.name);
    time.textContent = v.at == null ? (v.time == null ? "" : String(v.time)) : String(v.at);
  } else {
    name.textContent = v == null ? "" : String(v);
  }

  row.appendChild(name);
  row.appendChild(time);
  return row;
}

async function loadVisitors() {
  if (visitorsBusy) return;
  visitorsBusy = true;

  const wait = document.createElement("div");
  wait.className = "visitors-loading";
  const ring = document.createElement("i");
  ring.className = "spin lg";
  wait.appendChild(ring);
  visitorsShow(wait);

  const data = await post({ action: "visitors" });
  visitorsBusy = false;

  // 아예 못 받은 것은 브라우저가 겪은 일이라 그대로 알린다.
  if (!data) {
    visitorsShow(visitorsNote("응답을 받을 수 없습니다."));
    return;
  }

  // 받았는데 목록이 없으면 전부 같은 문장으로 덮는다.
  // 경우를 나눠 보여주면 그 구분 자체가 서버 상태를 알려주는 통로가 된다.
  if (!Array.isArray(data.visitors)) {
    visitorsShow(visitorsNote("지금은 명단을 볼 수 없습니다."));
    return;
  }

  if (!data.visitors.length) {
    visitorsShow(visitorsNote("이 시간대에는 입장 기록이 없습니다."));
    return;
  }

  const list = document.createDocumentFragment();
  data.visitors.forEach(v => list.appendChild(visitorRow(v)));
  if (data.more > 0) list.appendChild(visitorsNote("외 " + data.more + "명"));
  visitorsShow(list);
}

// 기록이 막힌 사람도 명단은 볼 수 있어야 한다.
// 그래서 실패 판에서도 이 길이 열려 있고, 여기서는 측위를 하지 않는다.
function openVisitors() {
  if (!credential || expired()) return relogin();
  back = phase;
  go("visitors");
  loadVisitors();
}

/* ── 입력 ──────────────────────────────────────────────────────── */

$("sid").addEventListener("input", e => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
  paint();
});

$("name").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); $("sid").focus(); }
});

$("sid").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  e.target.blur();
  if (sidOk()) $("morph").click();
});

$("morph").addEventListener("click", () => {
  if (phase === "new") {
    const name = $("name").value.trim();
    if (!name || !sidOk()) return;
    profile = { name: name, studentId: $("sid").value };
    go("rules");
  } else if (phase === "rules") {
    record();   // 주의사항을 확인하면 그대로 기록까지 간다
  } else if (phase === "failed") {
    record();   // 실패 판을 다시 누르면 재시도
  } else if (phase === "visitors") {
    go(back);
  }
});

$("more").addEventListener("click", openVisitors);

// 모바일 키보드가 올라오면 화면 아래쪽이 가려진다. 신규 등록 화면의 버튼은 정중앙에 있어서
// 그대로 두면 키보드 밑에 깔려 누를 수가 없다. 가려진 높이를 CSS 로 넘겨 그만큼 끌어올린다.
function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb", Math.round(hidden) + "px");
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();
}

/* ── 시작 ──────────────────────────────────────────────────────── */

// 인앱 브라우저 안내는 구글 스크립트를 기다릴 이유가 없다. 문서만 준비되면 바로 띄운다.
function boot() {
  $("ver").textContent = VERSION;
  trackKeyboard();

  if (IN_APP) {
    blocked = true;
    paint();
    say("카카오톡 안에서는 구글 로그인이 되지 않습니다. 오른쪽 아래 메뉴에서 '다른 브라우저로 열기'를 눌러주세요.");
  }
}

// FedCM 을 켜면 isDisplayed() 와 isSkippedMoment() 는 더 이상 쓸 수 없고 호출하면 예외가 난다.
// getMomentType() 이 그 자리를 대신하지만 없을 수도 있으므로 양쪽 모두 막아둔다.
function moment(n) {
  let shown = false;
  try {
    shown = typeof n.getMomentType === "function"
      ? n.getMomentType() === "display"
      : n.isDisplayed();
  } catch (e) {
    shown = false;
  }
  // 이미 로그인이 끝나 다른 화면으로 넘어갔다면 늦게 온 알림으로 문구를 덮지 않는다.
  if (!shown && phase === "login") say("위 버튼으로 로그인해주세요");
}

window.onload = () => {
  if (blocked) return;

  // 광고 차단기나 망 정책으로 구글 스크립트가 막히면 google 이 없다. 그대로 두면
  // 아래에서 예외가 나 뒤 코드가 전부 죽고, 화면은 "구글 계정 확인 중" 에서 멈춘다.
  if (!window.google || !google.accounts || !google.accounts.id) {
    say("구글 로그인을 불러오지 못했습니다. 네트워크를 확인하고 새로고침해주세요.");
    return;
  }

  warmUp();

  try {
    google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: onCredential,
      auto_select: true,
      use_fedcm_for_prompt: true,
      itp_support: true,
      cancel_on_tap_outside: false
    });
    // 폭은 계정 이름 길이에 따라 달라지므로 고정하지 않는다
    google.accounts.id.renderButton($("gsi"), {
      theme: "filled_black", shape: "pill", size: "large", text: "signin_with", locale: "ko"
    });
  } catch (e) {
    say("구글 로그인을 시작하지 못했습니다. 새로고침해주세요.");
    return;
  }

  try {
    google.accounts.id.prompt(moment);
  } catch (e) {
    say("위 버튼으로 로그인해주세요");
  }
};

paint();
boot();
