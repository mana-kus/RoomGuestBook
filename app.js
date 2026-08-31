/* 동작 전담. 색·크기·모션은 style.css 에서만 다룹니다.
   여기서는 <body> 의 ph-* 클래스를 바꿀 뿐이고, 그 결과 보이는 모습은 전부 CSS 가 정합니다. */

const CLIENT_ID = "60891083163-acnj22k5h7m921srilkdvbi8is0o60sv.apps.googleusercontent.com";
const ENDPOINT  = "https://script.google.com/macros/s/AKfycbxBwVkyj3PLy0nKJmBXPFN-UweRpH99d-p3SbkF1XUQf4pKt086OcXHm1_UCcnA6W-X/exec";

const POS_HELP = {
  denied: "위치 확인이 차단되어 있습니다.",
  unavailable: "위치를 확인할 수 없습니다."
};

const IN_APP = /KAKAOTALK|Instagram|FBAN|FBAV|FB_IAB|Line\/|NAVER|DaumApps|everytime/i
  .test(navigator.userAgent);

const $ = id => document.getElementById(id);

let credential = null;
let profile = null;      // 신규 등록 시 함께 보낼 이름·학번
let phase = "login";
let burst = false;
let blocked = false;
let jelly = 0;

const payload = jwt => JSON.parse(new TextDecoder().decode(
  Uint8Array.from(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))
));

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

// 실패 판 안에 들어갈 문자열. 서버·브라우저가 준 것만 그대로 보여준다.
function fail(text) {
  $("failReason").textContent = text || "";
  say("");
  go("failed");
}

async function post(extra) {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ credential: credential }, extra))
  });
  return r.json();
}

// timeout 은 권한 팝업을 띄워둔 시간까지 함께 센다. 처음 오는 사람은 팝업을 읽고
// 누르는 동안 시간이 흐르므로 넉넉히 준다. maximumAge 는 최근에 잡아둔 위치를
// 그대로 쓰게 해서 두 번째부터는 기다림이 없다.
const getPos = timeout => new Promise(done => {
  if (!navigator.geolocation) return done({ error: "unavailable" });
  navigator.geolocation.getCurrentPosition(
    p => done({ lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
    e => done({ error: e.code === 1 ? "denied" : "unavailable" }),
    { enableHighAccuracy: false, timeout: timeout, maximumAge: 300000 }
  );
});

// 첫 측위는 콜드 스타트라 한 번에 실패하는 일이 잦다. 시간이 모자라 실패한 경우에만
// 한 번 더 시도한다. 사용자가 거부한 경우(denied)는 다시 물어도 소용없으므로 그대로 둔다.
async function pos() {
  const first = await getPos(20000);
  if (first.error !== "unavailable") return first;
  return getPos(20000);
}

// 로그인만 하면 바로 기록한다. 누를 것이 없다.
// 등록된 계정인지는 서버가 이 요청 안에서 판단해 needProfile 로 알려주므로,
// 미리 물어보는 왕복을 따로 두지 않는다.
function onCredential(res) {
  credential = res.credential;
  const p = payload(credential);
  $("meLabel").textContent = (p.name || p.email) + " 님으로";
  say("");
  record();
}

async function record() {
  go("saving");
  $("savingLabel").textContent = "위치 확인 중";
  say("");

  const geo = await pos();
  $("savingLabel").textContent = "기록 중";

  try {
    const data = await post(Object.assign({ pos: geo.error ? null : geo }, profile));

    if (data.needProfile) { go("new"); return; }

    if (data.ok === true || data.recent) {
      const time = clock();
      $("doneTime").textContent = time;
      $("settledTime").textContent = time;
      $("settledLabel").textContent = data.recent ? "이미 기록되어 있습니다" : "완료되었습니다";

      if (data.recent) { go("settled"); return; }

      if (navigator.vibrate) navigator.vibrate(60);
      burst = true;
      go("done");
      setTimeout(() => { burst = false; paint(); }, 1000);
      setTimeout(() => go("settled"), 1250);
      return;
    }

    fail(geo.error ? POS_HELP[geo.error] : "지금은 기록할 수 없습니다.");
  } catch (e) {
    fail("연결에 실패했습니다. 다시 눌러주세요.");
  }
}

$("sid").addEventListener("input", e => {
  e.target.value = e.target.value.replace(/\D/g, "").slice(0, 10);
  paint();
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
  }
});

window.onload = () => {
  if (IN_APP) {
    blocked = true;
    paint();
    say("카카오톡 안에서는 구글 로그인이 되지 않습니다. 오른쪽 아래 메뉴에서 '다른 브라우저로 열기'를 눌러주세요.");
    return;
  }

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
  google.accounts.id.prompt(n => {
    if (!n.isDisplayed() && !n.isSkippedMoment()) return;
    say("위 버튼으로 로그인해주세요");
  });
};

paint();
