// === Last30Days PWA - Frontend ===

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// --- PWA Install ---
let deferredPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = $("#install-btn");
  btn.hidden = false;
  btn.addEventListener("click", async () => {
    btn.hidden = true;
    deferredPrompt.prompt();
    const result = await deferredPrompt.userChoice;
    deferredPrompt = null;
  });
});

// --- Service Worker Registration ---
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// --- State ---
let isSearching = false;

// --- Status Check ---
async function checkStatus() {
  try {
    const res = await fetch("/api/status");
    if (!res.ok) return;
    const data = await res.json();
    showStatus(data);
  } catch {
    // Server might not be running
  }
}

function showStatus(data) {
  const bar = $("#status-bar");
  const container = $("#status-sources");

  const sources = [
    { name: "Reddit", active: data.has_openai, key: "OPENAI_API_KEY" },
    {
      name: "X",
      active: data.has_xai || data.bird_authenticated,
      key: data.bird_authenticated ? "Bird CLI" : "XAI_API_KEY",
    },
  ];

  container.innerHTML =
    '<span>Bronnen: </span>' +
    sources
      .map(
        (s) =>
          `<span class="status-chip ${s.active ? "active" : "inactive"}">${s.name}${s.active ? " \u2713" : ""}</span>`
      )
      .join("");

  bar.hidden = false;
}

// --- Search ---
const form = $("#search-form");
form.addEventListener("submit", (e) => {
  e.preventDefault();
  if (isSearching) return;
  doSearch();
});

async function doSearch() {
  const topic = $("#topic-input").value.trim();
  if (!topic) return;

  isSearching = true;
  const btn = $("#search-btn");
  btn.disabled = true;
  btn.querySelector(".btn-text").hidden = true;
  btn.querySelector(".btn-spinner").hidden = false;

  hideResults();
  hideError();
  showProgress();

  const payload = {
    topic,
    sources: $("#sources-select").value,
    depth: $("#depth-select").value,
    days: parseInt($("#days-input").value) || 30,
  };

  try {
    updateProgress(20, "Bronnen doorzoeken...");
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    updateProgress(80, "Resultaten verwerken...");

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    updateProgress(100, "Klaar!");

    setTimeout(() => {
      hideProgress();
      renderResults(data);
    }, 300);
  } catch (err) {
    hideProgress();
    showError(err.message);
  } finally {
    isSearching = false;
    btn.disabled = false;
    btn.querySelector(".btn-text").hidden = false;
    btn.querySelector(".btn-spinner").hidden = true;
  }
}

// --- Progress ---
function showProgress() {
  const el = $("#progress");
  el.hidden = false;
  el.classList.add("fade-in");
  updateProgress(5, "Onderzoek starten...");
}

function updateProgress(pct, text) {
  $("#progress-fill").style.width = pct + "%";
  $("#progress-text").textContent = text;
}

function hideProgress() {
  $("#progress").hidden = true;
}

// --- Error ---
function showError(msg) {
  const el = $("#error");
  $("#error-message").textContent = msg;
  el.hidden = false;
  el.classList.add("fade-in");
}

function hideError() {
  $("#error").hidden = true;
}

// Exposed for inline onclick
window.dismissError = hideError;

// --- Results ---
function hideResults() {
  $("#results").hidden = true;
}

function renderResults(data) {
  const results = $("#results");
  results.hidden = false;
  results.classList.add("fade-in");

  // Header
  $("#results-topic").textContent = data.topic;

  const range = data.range || {};
  const metaParts = [];
  if (range.from && range.to) {
    metaParts.push(`<span>${range.from} - ${range.to}</span>`);
  }
  if (data.mode) {
    metaParts.push(`<span>Modus: ${data.mode}</span>`);
  }
  const rCount = (data.reddit || []).length;
  const xCount = (data.x || []).length;
  metaParts.push(`<span>${rCount + xCount} resultaten</span>`);
  $("#results-meta").innerHTML = metaParts.join("");

  // Reddit
  const redditSection = $("#reddit-section");
  const redditList = $("#reddit-results");
  if (data.reddit && data.reddit.length > 0) {
    redditSection.hidden = false;
    $("#reddit-count").textContent = data.reddit.length;
    redditList.innerHTML = data.reddit.map(renderRedditCard).join("");
  } else {
    redditSection.hidden = true;
  }

  // X
  const xSection = $("#x-section");
  const xList = $("#x-results");
  if (data.x && data.x.length > 0) {
    xSection.hidden = false;
    $("#x-count").textContent = data.x.length;
    xList.innerHTML = data.x.map(renderXCard).join("");
  } else {
    xSection.hidden = true;
  }

  // Empty
  const hasResults = (data.reddit && data.reddit.length) || (data.x && data.x.length);
  $("#empty-state").hidden = hasResults;

  // Show errors if any
  if (data.reddit_error) {
    redditSection.hidden = false;
    redditList.innerHTML = `<div class="item-card reddit-card"><p class="error-title">Reddit Fout</p><p class="item-text">${esc(data.reddit_error)}</p></div>`;
  }
  if (data.x_error) {
    xSection.hidden = false;
    xList.innerHTML = `<div class="item-card x-card"><p class="error-title">X Fout</p><p class="item-text">${esc(data.x_error)}</p></div>`;
  }
}

function renderRedditCard(item) {
  const engHtml = renderEngagement(item.engagement, "reddit");
  const insightsHtml = renderInsights(item.comment_insights);

  return `
    <div class="item-card reddit-card fade-in">
      <div class="item-header">
        <div class="item-title"><a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.title)}</a></div>
        <div class="item-score">${item.score}</div>
      </div>
      <div class="item-meta">
        <span class="meta-reddit">r/${esc(item.subreddit)}</span>
        ${item.date ? `<span>${item.date}</span>` : ""}
      </div>
      ${engHtml}
      ${item.why_relevant ? `<div class="item-relevance">${esc(item.why_relevant)}</div>` : ""}
      ${insightsHtml}
    </div>
  `;
}

function renderXCard(item) {
  const engHtml = renderEngagement(item.engagement, "x");
  const text = item.text ? item.text.slice(0, 280) : "";

  return `
    <div class="item-card x-card fade-in">
      <div class="item-header">
        <div class="item-title"><a href="${esc(item.url)}" target="_blank" rel="noopener">@${esc(item.author_handle)}</a></div>
        <div class="item-score">${item.score}</div>
      </div>
      <div class="item-meta">
        ${item.date ? `<span>${item.date}</span>` : ""}
      </div>
      <div class="item-text">${esc(text)}</div>
      ${engHtml}
      ${item.why_relevant ? `<div class="item-relevance">${esc(item.why_relevant)}</div>` : ""}
    </div>
  `;
}

function renderEngagement(eng, type) {
  if (!eng) return "";
  const badges = [];

  if (type === "reddit") {
    if (eng.score != null) badges.push(`<span class="engagement-badge reddit-eng">${eng.score} pts</span>`);
    if (eng.num_comments != null) badges.push(`<span class="engagement-badge reddit-eng">${eng.num_comments} comments</span>`);
  } else {
    if (eng.likes != null) badges.push(`<span class="engagement-badge x-eng">${eng.likes} likes</span>`);
    if (eng.reposts != null) badges.push(`<span class="engagement-badge x-eng">${eng.reposts} reposts</span>`);
  }

  return badges.length ? `<div class="item-engagement">${badges.join("")}</div>` : "";
}

function renderInsights(insights) {
  if (!insights || !insights.length) return "";
  const items = insights
    .slice(0, 3)
    .map((i) => `<p>${esc(i)}</p>`)
    .join("");
  return `<div class="item-insights">${items}</div>`;
}

// --- Utilities ---
function esc(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---
checkStatus();
