const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const state = { profile: null, busy: false };
const $ = id => document.getElementById(id);
const headers = () => {
  const h = { "Content-Type": "application/json" };
  if (tg?.initData) h["X-Telegram-Init-Data"] = tg.initData;
  else h["X-Dev-User"] = "1";
  return h;
};

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Ошибка запроса");
  return data;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.remove("show"), 1900);
}
function number(n) { return Math.floor(n || 0).toLocaleString("ru-RU"); }

function render(p) {
  state.profile = p;
  $("playerName").textContent = p.firstName || "Игрок";
  $("balance").textContent = number(p.coins);
  $("income").textContent = number(p.incomePerHour);
  $("tapPower").textContent = p.tapPower;
  $("friends").textContent = p.referralCount;
  $("energy").textContent = number(p.energy);
  $("maxEnergy").textContent = number(p.maxEnergy);
  $("energyFill").style.width = `${Math.max(0, Math.min(100, p.energy / p.maxEnergy * 100))}%`;
  $("rank").textContent = String(Math.max(1, Math.floor(p.coins / 5000) + 1)).padStart(2, "0");

  $("upgradeList").innerHTML = p.upgrades.map((u, i) => `
    <div class="upgrade-card">
      <div class="upgrade-icon">${["✧","⚡","◉","◈"][i]}</div>
      <div class="upgrade-info"><b>${u.name}</b><small>${u.description}</small><span class="level">УРОВЕНЬ ${u.level}/${u.maxLevel}</span></div>
      <button class="buy-button" data-buy="${u.id}" ${u.level >= u.maxLevel || p.coins < u.cost ? "disabled" : ""}>${u.level >= u.maxLevel ? "MAX" : `✦ ${number(u.cost)}`}</button>
    </div>`).join("");

  $("taskList").innerHTML = p.tasks.map((t, i) => `
    <div class="task-card">
      <div class="task-icon">${["◷","✦","♧"][i]}</div>
      <div class="task-info"><b>${t.title}</b><small>${t.description}</small></div>
      <button class="claim-button" data-task="${t.id}" ${t.claimed || !t.available ? "disabled" : ""}>${t.claimed ? "ГОТОВО" : !t.available ? "ЗАКРЫТО" : `+${number(t.reward)}`}</button>
    </div>`).join("");

  const botName = tg?.initDataUnsafe?.user ? "" : "";
  const link = `https://t.me/${window.TURAN_BOT_USERNAME || "YOUR_BOT_USERNAME"}?startapp=${encodeURIComponent(p.referralCode)}`;
  $("refCode").textContent = link;
}

async function load() {
  try {
    render(await api("/api/me"));
    loadLeaders();
  } catch (e) { toast(e.message); }
}
async function loadLeaders() {
  try {
    const rows = await api("/api/leaderboard");
    $("leaderboard").innerHTML = rows.map((r, i) => `
      <div class="leader-row"><span class="leader-rank">${String(i+1).padStart(2,"0")}</span><span class="leader-name">${escapeHtml(r.name)}</span><span class="leader-score">${number(r.coins)} ✦</span></div>
    `).join("") || '<div class="leader-row">Пока нет игроков</div>';
  } catch {}
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}

$("tapButton").addEventListener("click", async e => {
  if (state.busy) return;
  state.busy = true;
  try {
    const p = await api("/api/click", { count: 1 });
    render(p);
    const pop = document.createElement("span");
    pop.className = "float-reward";
    pop.textContent = `+${p.reward} ✦`;
    pop.style.left = `${42 + Math.random()*16}%`;
    pop.style.top = "35%";
    $("tapButton").parentElement.appendChild(pop);
    setTimeout(() => pop.remove(), 850);
  } catch (err) { toast(err.message); }
  finally { state.busy = false; }
});

$("upgradeList").addEventListener("click", async e => {
  const button = e.target.closest("[data-buy]");
  if (!button) return;
  button.disabled = true;
  try { render(await api("/api/buy", { upgradeId: button.dataset.buy })); toast("Улучшение куплено"); }
  catch (err) { toast(err.message); }
});
$("taskList").addEventListener("click", async e => {
  const button = e.target.closest("[data-task]");
  if (!button) return;
  button.disabled = true;
  try { render(await api("/api/claim-task", { taskId: button.dataset.task })); toast("Награда получена"); }
  catch (err) { toast(err.message); }
});
$("shareButton").addEventListener("click", async () => {
  const url = $("refCode").textContent;
  if (tg?.openTelegramLink) {
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent("Присоединяйся к TURAN!")}`);
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(url); toast("Ссылка скопирована");
  } else toast("Скопируй ссылку из поля ниже");
});
document.querySelectorAll(".nav-item").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".nav-item").forEach(x => x.classList.remove("active"));
  button.classList.add("active");
  const target = button.dataset.target;
  if (target === "top") window.scrollTo({ top: 0, behavior: "smooth" });
  else document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
}));

load();
setInterval(() => { if (!document.hidden) load(); }, 30000);
