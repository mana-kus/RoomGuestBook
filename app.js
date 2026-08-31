/* 동작 전담. 색·여백·글꼴은 style.css 에서만 다룹니다. */

const CLIENT_ID = "60891083163-acnj22k5h7m921srilkdvbi8is0o60sv.apps.googleusercontent.com";
const ENDPOINT  = "https://script.google.com/macros/s/AKfycbxBwVkyj3PLy0nKJmBXPFN-UweRpH99d-p3SbkF1XUQf4pKt086OcXHm1_UCcnA6W-X/exec";

const POS_HELP = {
  denied: "위치 확인이 차단되어 있습니다.",
  unavailable: "위치를 확인할 수 없습니다."
};

const IN_APP = /KAKAOTALK|Instagram|FBAN|FBAV|FB_IAB|Line\/|NAVER|DaumApps|everytime/i
  .test(navigator.userAgent);

/* 주소 뒤에 ?debug=1 을 붙이면 실패 원인을 화면에 그대로 보여줍니다. */
const DEBUG = location.search.indexOf("debug") >= 0;
const detail = t => DEBUG ? "  [" + t + "]" : "";

const $ = id => document.getElementById(id);
let credential = null;
let profile = null;

const payload = jwt => JSON.parse(new TextDecoder().decode(
  Uint8Array.from(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))
));

function onCredential(res) {
  credential = res.credential;
  const p = payload(credential);
  $("gbtn").innerHTML = "";
  $("status").textContent = "";
  showButton((p.name || p.email) + "님으로 방명록 남기기");
}

function showButton(label) {
  $("action").innerHTML = '<button class="sign" id="submit"></button>';
  $("submit").textContent = label;
  $("submit").onclick = () => submit();
}

const getPos = () => new Promise(done => {
  if (!navigator.geolocation) {
    return done({ error: "unavailable", why: "geolocation 없음 / " + location.protocol });
  }
  navigator.geolocation.getCurrentPosition(
    p => done({ lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
    e => done({
      error: e.code === 1 ? "denied" : "unavailable",
      why: "code " + e.code + " " + e.message + " / " + location.protocol
    }),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
  );
});

async function submit() {
  const btn = $("submit");
  btn.disabled = true;
  $("status").textContent = "위치 확인 중…";
  const geo = await getPos();
  const pos = geo.error ? null : geo;
  $("status").textContent = "기록 중…";
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ credential: credential, pos: pos }, profile))
    });
    const data = await r.json();

    if (data.needProfile) return askProfile();
    if (data.recent) {
      btn.textContent = "✓ 이미 기록됨";
      $("status").textContent = "1시간 이내에 이미 남기셨어요.";
    } else if (data.ok === true) {
      btn.textContent = "✓ 기록 완료";
      $("status").textContent = "방문해주셔서 감사합니다!";
    } else {
      btn.disabled = false;
      $("status").textContent = geo.error
        ? POS_HELP[geo.error] + detail(geo.why)
        : "지금은 기록할 수 없습니다." + detail(data.reason || "서버 거부 · 위치는 정상 전송됨");
    }
    showRoster(data);
  } catch (e) {
    btn.disabled = false;
    $("status").textContent = "연결에 실패했습니다. 다시 눌러주세요.";
  }
}

function showRoster(data) {
  if (!data.visitors || !data.visitors.length) return;
  const more = data.more ? ` 외 ${data.more}명` : "";
  $("roster").textContent = "최근 1시간 입장: " + data.visitors.join(", ") + more;
}

function askProfile() {
  $("action").innerHTML = `
    <form id="profile-form">
      <input id="name" placeholder="이름" required>
      <input id="sid" placeholder="학번 (숫자 10자리)" inputmode="numeric"
             pattern="\\d{10}" maxlength="10" required>
      <button class="sign" type="submit">등록하고 방명록 남기기</button>
    </form>`;
  $("name").value = payload(credential).name || "";
  $("status").textContent = "처음 오셨네요. 이름과 학번을 입력해주세요.";
  $("profile-form").onsubmit = ev => {
    ev.preventDefault();
    profile = { name: $("name").value.trim(), studentId: $("sid").value.trim() };
    showButton("등록 중…");
    submit();
  };
}

window.onload = () => {
  if (IN_APP) {
    $("status").textContent =
      "카카오톡 안에서는 구글 로그인이 되지 않습니다. " +
      "오른쪽 아래 메뉴에서 '다른 브라우저로 열기'를 눌러주세요.";
    return;
  }

  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: onCredential,
    auto_select: true
  });
  google.accounts.id.renderButton($("gbtn"), {
    theme: "filled_black", size: "large", text: "signin_with", shape: "pill", locale: "ko"
  });
  google.accounts.id.prompt(n => {
    if (!n.isDisplayed() && !n.isSkippedMoment()) return;
    $("status").textContent = "위 버튼으로 로그인해주세요";
  });
};

