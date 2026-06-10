// 登录闸门：app 启动前校验会话；未登录显示全屏登录；
// 会话失效(401)自动拉回登录；非超管隐藏配置/平台级入口。
// 注意：后端已强制鉴权与角色，本模块只负责体验，安全不依赖前端隐藏。

let overlayEl = null;
let stylesInjected = false;

function injectStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.textContent = `
.auth-gate{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;
  background:rgba(8,14,26,.92);backdrop-filter:blur(4px);}
.auth-gate__card{width:min(360px,90vw);padding:28px;border-radius:14px;
  background:var(--panel-strong,#101b2e);border:1px solid var(--line,#25334a);
  box-shadow:0 20px 60px rgba(0,0,0,.45);color:var(--text,#f5f0df);font-family:inherit;}
.auth-gate__title{margin:0 0 4px;font-size:18px;font-weight:700;}
.auth-gate__sub{margin:0 0 20px;font-size:13px;color:var(--muted,#91a0b7);}
.auth-gate__field{margin-bottom:14px;display:flex;flex-direction:column;gap:6px;}
.auth-gate__field label{font-size:12px;color:var(--muted,#91a0b7);}
.auth-gate__field input{padding:10px 12px;border-radius:9px;border:1px solid var(--line,#25334a);
  background:var(--soft,rgba(255,255,255,.055));color:var(--text,#f5f0df);font-size:14px;}
.auth-gate__field input:focus{outline:none;border-color:var(--accent,#f6b56b);}
.auth-gate__btn{width:100%;margin-top:6px;padding:11px;border:none;border-radius:9px;cursor:pointer;
  background:var(--accent,#f6b56b);color:#1a1206;font-weight:700;font-size:14px;}
.auth-gate__btn:disabled{opacity:.6;cursor:default;}
.auth-gate__error{min-height:18px;margin-top:10px;font-size:13px;color:#ff9a8a;}
.auth-userbar{position:fixed;top:10px;right:14px;z-index:50;display:flex;align-items:center;gap:10px;
  font-size:12px;color:var(--muted,#91a0b7);}
.auth-userbar__name{color:var(--text,#f5f0df);font-weight:600;}
.auth-userbar__role{padding:1px 7px;border-radius:999px;background:var(--soft,rgba(255,255,255,.08));}
.auth-userbar__logout{padding:4px 10px;border:1px solid var(--line,#25334a);border-radius:7px;
  background:transparent;color:var(--muted,#91a0b7);cursor:pointer;font-size:12px;}
.auth-userbar__logout:hover{color:var(--text,#f5f0df);border-color:var(--accent,#f6b56b);}
`;
  document.head.appendChild(style);
}

async function fetchMe() {
  try {
    const res = await fetch("/api/auth/me", { headers: { "content-type": "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.user || null;
  } catch {
    return null;
  }
}

function showLoginOverlay() {
  injectStyles();
  return new Promise((resolve) => {
    if (overlayEl) overlayEl.remove();
    overlayEl = document.createElement("div");
    overlayEl.className = "auth-gate";
    overlayEl.innerHTML = `
      <form class="auth-gate__card" autocomplete="on">
        <h1 class="auth-gate__title">模型评测平台</h1>
        <p class="auth-gate__sub">请登录（管理员及以上）</p>
        <div class="auth-gate__field">
          <label for="auth-username">用户名</label>
          <input id="auth-username" name="username" type="text" autocomplete="username" required />
        </div>
        <div class="auth-gate__field">
          <label for="auth-password">密码</label>
          <input id="auth-password" name="password" type="password" autocomplete="current-password" required />
        </div>
        <button class="auth-gate__btn" type="submit">登录</button>
        <div class="auth-gate__error" role="alert"></div>
      </form>`;
    document.body.appendChild(overlayEl);
    const form = overlayEl.querySelector("form");
    const errEl = overlayEl.querySelector(".auth-gate__error");
    const btn = overlayEl.querySelector(".auth-gate__btn");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      errEl.textContent = "";
      btn.disabled = true;
      btn.textContent = "登录中…";
      const fd = new FormData(form);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: fd.get("username"), password: fd.get("password") }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          errEl.textContent = data.userMessage || "登录失败，请重试。";
          btn.disabled = false;
          btn.textContent = "登录";
          return;
        }
        overlayEl.remove();
        overlayEl = null;
        resolve(data.user || null);
      } catch {
        errEl.textContent = "网络错误，请重试。";
        btn.disabled = false;
        btn.textContent = "登录";
      }
    });
    overlayEl.querySelector("#auth-username")?.focus();
  });
}

export async function ensureAuthenticated() {
  const me = await fetchMe();
  if (me) return me;
  return showLoginOverlay();
}

export function wireUnauthorizedRedirect() {
  window.addEventListener("evaluator:unauthorized", () => {
    if (overlayEl) return; // 已在登录中
    showLoginOverlay().then(() => window.location.reload());
  });
}

function injectUserBar(user) {
  if (document.querySelector(".auth-userbar")) return;
  injectStyles();
  const bar = document.createElement("div");
  bar.className = "auth-userbar";
  const roleLabel = Number(user?.role) >= 100 ? "超级管理员" : "管理员";
  bar.innerHTML = `
    <span class="auth-userbar__name"></span>
    <span class="auth-userbar__role"></span>
    <button class="auth-userbar__logout" type="button">登出</button>`;
  bar.querySelector(".auth-userbar__name").textContent = user?.username || "已登录";
  bar.querySelector(".auth-userbar__role").textContent = roleLabel;
  bar.querySelector(".auth-userbar__logout").addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // 即使登出请求失败也回登录态
    }
    window.location.reload();
  });
  document.body.appendChild(bar);
}

export function applyRoleVisibility(user) {
  injectUserBar(user);
  if (user?.canConfig) return;
  // 非超管：隐藏“API 配置”入口与所有标记为需超管的元素
  const profilesNav = document.querySelector('.nav-button[data-page="profiles"]');
  if (profilesNav) profilesNav.style.display = "none";
  document.querySelectorAll("[data-requires-admin]").forEach((el) => {
    el.style.display = "none";
  });
  // 若已落在仅超管可见的配置页（旧 API 配置 / 渠道管理），切回总览
  const active = document.querySelector(".page.active");
  if (active && (active.id === "profiles" || active.id === "channels")) {
    document.querySelector('.nav-button[data-page="dashboard"]')?.click();
  }
}
