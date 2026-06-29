// منصة العدالة - Najiz sync popup
const $ = (id) => document.getElementById(id);
const status = (msg, cls = "info") => {
  const el = $("status");
  el.className = "status show " + cls;
  el.textContent = msg;
};
const hideStatus = () => { $("status").className = "status"; };

// Load saved settings
chrome.storage.local.get(["baseUrl", "syncToken", "lastSync"], (s) => {
  if (s.baseUrl) $("baseUrl").value = s.baseUrl;
  if (s.syncToken) $("syncToken").value = s.syncToken;
  if (s.lastSync) {
    $("lastSync").innerHTML = 'آخر مزامنة: <span class="last-sync">' +
      new Date(s.lastSync).toLocaleString("ar-SA") + '</span>';
  }
  // Auto-open settings panel if missing config
  if (!s.baseUrl || !s.syncToken) $("settingsPanel").classList.add("open");
});

$("gearBtn").addEventListener("click", () => {
  $("settingsPanel").classList.toggle("open");
});

$("saveBtn").addEventListener("click", () => {
  const baseUrl = $("baseUrl").value.trim().replace(/\/$/, "");
  const syncToken = $("syncToken").value.trim();
  if (!baseUrl || !syncToken) return status("الرجاء تعبئة الرابط والرمز", "err");
  if (!/^https?:\/\//.test(baseUrl)) return status("الرابط يجب أن يبدأ بـ https://", "err");
  status("جارٍ التحقق من رابط المزامنة...", "info");
  chrome.runtime.sendMessage({ type: "ADALA_VERIFY_ENDPOINT", baseUrl }, (r) => {
    // Auto-correct preview URL → stable URL before saving.
    const finalUrl = (r && r.corrected) ? r.corrected : baseUrl;
    if (r && r.changed) $("baseUrl").value = finalUrl;
    chrome.storage.local.set({ baseUrl: finalUrl, syncToken }, () => {
      if (r && !r.ok) {
        status("⚠️ تم الحفظ لكن الرابط قد لا يصل لواجهة المزامنة: " + (r.reason || ""), "err");
        return;
      }
      const note = r && r.changed ? " (تم تصحيح الرابط تلقائياً)" : "";
      status("تم حفظ الإعدادات والتحقق من الرابط بنجاح ✓" + note, "ok");
      setTimeout(() => { hideStatus(); $("settingsPanel").classList.remove("open"); }, 1500);
    });
  });
});

async function ensureConfig() {
  const { baseUrl, syncToken } = await chrome.storage.local.get(["baseUrl", "syncToken"]);
  if (!baseUrl || !syncToken) {
    $("settingsPanel").classList.add("open");
    status("الرجاء حفظ رابط المنصة ورمز المزامنة من الإعدادات أولاً", "err");
    return null;
  }
  return { baseUrl, syncToken };
}

async function scrapeOnPage(kindFilter) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("najiz.sa")) {
    status("افتح أولاً صفحة من منصة ناجز (najiz.sa) ثم اضغط المزامنة", "err");
    return null;
  }
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [kindFilter],
    func: (kf) => (window.__ADALA_NAJIZ__ ? window.__ADALA_NAJIZ__.scrape(kf) : { kind: "mixed" }),
  });
  return r?.result ?? { kind: "mixed" };
}

function countItems(p) {
  return (p.cases?.length ?? 0) + (p.powers?.length ?? 0) +
         (p.executions?.length ?? 0) + (p.sessions?.length ?? 0) +
         (p.documents?.length ?? 0);
}

// Diagnostic mode: human-readable breakdown of detected items per section.
function diagnose(p) {
  const parts = [];
  if (p.cases?.length) parts.push(`قضايا: ${p.cases.length}`);
  if (p.sessions?.length) parts.push(`جلسات: ${p.sessions.length}`);
  if (p.powers?.length) parts.push(`وكالات: ${p.powers.length}`);
  if (p.executions?.length) parts.push(`تنفيذ: ${p.executions.length}`);
  if (p.documents?.length) parts.push(`مستندات: ${p.documents.length}`);
  return parts.join(" · ");
}

async function runSync(kindFilter, label) {
  hideStatus();
  const cfg = await ensureConfig();
  if (!cfg) return;
  disableAll(true);
  try {
    status(`جارٍ سحب البيانات (${label})...`, "info");
    const payload = await scrapeOnPage(kindFilter);
    if (!payload) return;
    const n = countItems(payload);
    if (!n) {
      status("🔎 وضع التشخيص: تم اكتشاف 0 عنصر. الأسباب المحتملة: الصفحة لم تكتمل، أو لم تسجّل الدخول عبر نفاذ، أو هذه ليست الصفحة الصحيحة. مرّر للأسفل حتى تظهر كل الصفوف ثم أعد المحاولة.", "err");
      return;
    }
    status(`🔎 تم اكتشاف ${n} عنصر (${diagnose(payload)}) — جارٍ الإرسال...`, "info");
    const resp = await chrome.runtime.sendMessage({
      type: "ADALA_SYNC", baseUrl: cfg.baseUrl, syncToken: cfg.syncToken, payload,
    });
    if (!resp?.ok) {
      status("فشل: " + (resp?.error || "خطأ غير معروف"), "err");
      return;
    }
    const d = resp.data || {};
    const now = new Date().toISOString();
    chrome.storage.local.set({ lastSync: now });
    $("lastSync").innerHTML = 'آخر مزامنة: <span class="last-sync">' +
      new Date(now).toLocaleString("ar-SA") + '</span>';
    status(`✓ تمت المزامنة — ${d.total ?? n} إجمالي · ${d.inserted ?? 0} جديد · ${d.updated ?? 0} محدّث`, "ok");
  } catch (err) {
    status("خطأ: " + (err?.message || err), "err");
  } finally {
    disableAll(false);
  }
}

function disableAll(v) {
  $("syncAllBtn").disabled = v;
  document.querySelectorAll(".chip").forEach((b) => b.disabled = v);
}

$("syncAllBtn").addEventListener("click", () => runSync(null, "جميع البيانات"));
document.querySelectorAll(".chip").forEach((btn) => {
  btn.addEventListener("click", () => runSync(btn.dataset.kind, btn.textContent.trim()));
});

// ---------- Autopilot (RPA bot) ----------
let progressPoll = null;
async function startAutopilot() {
  hideStatus();
  const cfg = await ensureConfig();
  if (!cfg) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes("najiz.sa")) {
    status("افتح أولاً منصة ناجز وسجّل دخولك عبر نفاذ، ثم اضغط البوت مرة أخرى", "err");
    return;
  }
  disableAll(true);
  $("autopilotBtn").disabled = true;
  status("🤖 جارٍ تشغيل البوت التلقائي...", "info");

  // Start polling progress (background continues after popup closes)
  if (progressPoll) clearInterval(progressPoll);
  progressPoll = setInterval(async () => {
    const r = await chrome.runtime.sendMessage({ type: "ADALA_AUTOPILOT_STATUS" });
    const p = r?.progress;
    if (!p) return;
    if (p.error) { status("⚠️ " + p.error, "err"); }
    else if (p.finished) { status("✓ " + (p.message || "اكتمل البوت"), "ok"); clearInterval(progressPoll); disableAll(false); $("autopilotBtn").disabled = false; }
    else if (p.message) { status(`🤖 [${p.currentStep || 0}/${p.totalSteps || 4}] ${p.message}`, "info"); }
  }, 800);

  chrome.runtime.sendMessage({
    type: "ADALA_AUTOPILOT_START",
    tabId: tab.id, baseUrl: cfg.baseUrl, syncToken: cfg.syncToken,
  }, (resp) => {
    if (resp && !resp.ok && resp.error) status("فشل: " + resp.error, "err");
    setTimeout(() => { disableAll(false); $("autopilotBtn").disabled = false; }, 500);
  });
}
$("autopilotBtn").addEventListener("click", startAutopilot);

// Resume progress display if popup reopens during a run
(async () => {
  const r = await chrome.runtime.sendMessage({ type: "ADALA_AUTOPILOT_STATUS" });
  if (r?.running && r.progress?.message) {
    status(`🤖 ${r.progress.message}`, "info");
    $("autopilotBtn").disabled = true;
    progressPoll = setInterval(async () => {
      const x = await chrome.runtime.sendMessage({ type: "ADALA_AUTOPILOT_STATUS" });
      const p = x?.progress; if (!p) return;
      if (p.finished) { status("✓ " + (p.message || "اكتمل"), "ok"); clearInterval(progressPoll); $("autopilotBtn").disabled = false; }
      else if (p.error) { status("⚠️ " + p.error, "err"); clearInterval(progressPoll); $("autopilotBtn").disabled = false; }
      else if (p.message) { status(`🤖 [${p.currentStep || 0}/${p.totalSteps || 4}] ${p.message}`, "info"); }
    }, 800);
  }
})();
