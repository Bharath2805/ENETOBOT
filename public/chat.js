const SESSION_KEY = "chatbot-session-id";
const WEB_SEARCH_MODE_KEY = "chatbot-web-search-mode";
const MAX_TEXTAREA_HEIGHT = 140;
const MAX_SESSION_FILES = 20;
const INGEST_POLL_INTERVAL_MS = 1500;
const STARTER_PROMPTS = [
  "How does Eneto Connect help lower energy costs?",
  "Which Eneto system is best for heating and cooling?",
  "How much funding is available and what qualifies?",
  "What happens after I request a fixed-price quote?"
];

const STATUS_MESSAGES = {
  summarizing: "Summarizing earlier context...",
  searching: "Searching the web...",
  searched: "Fresh web context ready...",
  retrieving: "Retrieving the most relevant document context...",
  responding: "Writing answer..."
};

const messagesEl = document.getElementById("messages");
const inputEl = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const fileBtn = document.getElementById("file-btn");
const fileInputEl = document.getElementById("file-input");
const webSearchToggleEl = document.getElementById("web-search-toggle");
const webSearchStatusEl = document.getElementById("web-search-status");
const resetBtn = document.getElementById("reset-btn");
const attachmentRowEl = document.getElementById("attachment-row");
const inputHintEl = document.getElementById("input-hint");
const ingestBannerEl = document.getElementById("ingest-banner");
const recentChatsEl = document.getElementById("recent-chats");
const chatTitleEl = document.getElementById("chat-title");
const chatTopbarEl = document.getElementById("chat-topbar");
const sidebarEl = document.getElementById("sidebar");
const sidebarToggleEl = document.getElementById("sidebar-toggle");
const mobileSidebarFabEl = document.getElementById("mobile-sidebar-fab");
const sidebarOverlayEl = document.getElementById("sidebar-overlay");
const chatMenuBtn = document.getElementById("chat-menu-btn");
const chatMenuPopover = document.getElementById("chat-menu-popover");

let sessionId = getOrCreateSessionId();
let attachments = [];
let webSearchMode = getStoredWebSearchMode();
let isStreaming = false;
let isUploading = false;
let hintOverride = "";
let hintOverrideTimerId = null;
let pendingUploadLabel = "";
let scrollRafId = null;
let ingestBannerTickerId = null;
const pendingIngestionJobs = new Map();
const ingestPollTimeoutIds = new Map();

function getOrCreateSessionId() {
  const existingId = sessionStorage.getItem(SESSION_KEY);

  if (existingId) {
    return existingId;
  }

  const newId = crypto.randomUUID();
  sessionStorage.setItem(SESSION_KEY, newId);
  return newId;
}

function getStoredWebSearchMode() {
  const storedMode = localStorage.getItem(WEB_SEARCH_MODE_KEY);
  const legacyEnabled = localStorage.getItem("chatbot-web-search-enabled") === "true";

  if (["auto", "always", "off"].includes(storedMode)) {
    return storedMode;
  }

  return legacyEnabled ? "always" : "auto";
}

function getTimeLabel() {
  return new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function getWebSearchModeCopy() {
  if (webSearchMode === "always") {
    return {
      label: "On",
      shortLabel: "On",
      title: "Web search: Always on — uses live web sources for every message"
    };
  }

  if (webSearchMode === "off") {
    return {
      label: "Off",
      shortLabel: "Off",
      title: "Web search: Off — disables automatic and forced web lookup"
    };
  }

  return {
    label: "Auto",
    shortLabel: "A",
    title: "Web search: Auto — uses smart triggering for current topics"
  };
}

function cycleWebSearchMode() {
  webSearchMode = webSearchMode === "auto"
    ? "always"
    : webSearchMode === "always"
      ? "off"
      : "auto";
  localStorage.setItem(WEB_SEARCH_MODE_KEY, webSearchMode);
  updateComposerState();
}

function updateComposerState() {
  const totalAttachmentCount = attachments.length + pendingIngestionJobs.size;
  const isIndexing = hasActivePendingJobs();
  const isBlocked = isStreaming || isUploading || isIndexing;

  sendBtn.disabled = !inputEl.value.trim() || isBlocked;
  inputEl.placeholder = (isIndexing || isUploading)
    ? "Preparing your file — chat unlocks in a moment..."
    : "Ask about Eneto, live updates, onboarding, or upload a file and ask about it...";
  fileBtn.disabled =
    isStreaming || isUploading || totalAttachmentCount >= MAX_SESSION_FILES;
  webSearchToggleEl.disabled = isBlocked;
  webSearchToggleEl.dataset.mode = webSearchMode;
  webSearchToggleEl.classList.toggle("is-on", webSearchMode === "always");
  webSearchToggleEl.classList.toggle("is-off", webSearchMode === "off");
  const modeCopy = getWebSearchModeCopy();
  webSearchToggleEl.title = modeCopy.title;
  webSearchToggleEl.setAttribute("aria-label", modeCopy.title);
  webSearchStatusEl.textContent = modeCopy.shortLabel;

  if (isIndexing || isUploading) {
    inputHintEl.textContent = "Chat is locked while your file is being prepared.";
    updateIngestBanner();
    return;
  }

  updateIngestBanner();

  if (hintOverride) {
    inputHintEl.textContent = hintOverride;
    return;
  }

  inputHintEl.textContent = totalAttachmentCount
    ? `${totalAttachmentCount} attached file${totalAttachmentCount === 1 ? "" : "s"} in this chat`
    : "";
}

function setHintOverride(message) {
  hintOverride = message;
  clearTimeout(hintOverrideTimerId);
  updateComposerState();

  hintOverrideTimerId = setTimeout(() => {
    hintOverride = "";
    updateComposerState();
  }, 5000);
}

function autoResizeTextarea() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Batches scroll calls during streaming so at most one DOM write happens per
// animation frame (~60fps) instead of once per chunk (can be 80-100/sec).
function scheduleScroll() {
  if (scrollRafId !== null) return;
  scrollRafId = requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    scrollRafId = null;
  });
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getBubbleCitations(bubbleEl) {
  try {
    const citations = JSON.parse(bubbleEl?.dataset?.citations || "[]");
    return Array.isArray(citations) ? citations : [];
  } catch (_error) {
    return [];
  }
}

function getCitationByNumber(citations, number) {
  return citations[number - 1] || null;
}

function formatCitationMarkers(html, citations) {
  return html.replace(/\[(\d+)\]/g, (match, rawNumber) => {
    const number = Number(rawNumber);
    const citation = getCitationByNumber(citations, number);

    if (!citation) {
      return "";
    }

    return `<button class="citation-marker" type="button" data-cite-number="${number}" data-cite-id="${escapeHtml(citation.id)}" aria-label="Open citation ${number}">[${number}]</button>`;
  });
}

function formatInline(text, citations = []) {
  const html = escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");

  return formatCitationMarkers(html, citations);
}

function formatText(text, citations = []) {
  const lines = String(text || "").split("\n");
  const htmlParts = [];
  let paragraphLines = [];
  let listType = null;

  function flushParagraph() {
    if (!paragraphLines.length) {
      return;
    }

    htmlParts.push(
      `<p>${paragraphLines.map((line) => formatInline(line, citations)).join("<br>")}</p>`
    );
    paragraphLines = [];
  }

  function closeList() {
    if (!listType) {
      return;
    }

    htmlParts.push(listType === "ul" ? "</ul>" : "</ol>");
    listType = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      closeList();
      continue;
    }

    if (/^###\s+/.test(line)) {
      flushParagraph();
      closeList();
      htmlParts.push(`<h3>${formatInline(line.replace(/^###\s+/, ""), citations)}</h3>`);
      continue;
    }

    if (/^##\s+/.test(line)) {
      flushParagraph();
      closeList();
      htmlParts.push(`<h2>${formatInline(line.replace(/^##\s+/, ""), citations)}</h2>`);
      continue;
    }

    if (/^#\s+/.test(line)) {
      flushParagraph();
      closeList();
      htmlParts.push(`<h1>${formatInline(line.replace(/^#\s+/, ""), citations)}</h1>`);
      continue;
    }

    const unorderedMatch = line.match(/^[-*]\s+(.*)$/);

    if (unorderedMatch) {
      flushParagraph();

      if (listType !== "ul") {
        closeList();
        htmlParts.push("<ul>");
        listType = "ul";
      }

      htmlParts.push(`<li>${formatInline(unorderedMatch[1], citations)}</li>`);
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);

    if (orderedMatch) {
      flushParagraph();

      if (listType !== "ol") {
        closeList();
        htmlParts.push("<ol>");
        listType = "ol";
      }

      htmlParts.push(`<li>${formatInline(orderedMatch[1], citations)}</li>`);
      continue;
    }

    closeList();
    paragraphLines.push(line);
  }

  flushParagraph();
  closeList();

  return htmlParts.join("");
}

function formatBytes(value) {
  const size = Number(value || 0);

  if (!Number.isFinite(size) || size <= 0) {
    return "";
  }

  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function getPendingAttachmentStatus(attachment) {
  const status = getAttachmentIngestionStatus(attachment);

  if (status === "failed") {
    return "Failed — try re-uploading";
  }

  if (status === "done") {
    return "Ready";
  }

  return "Processing…";
}

function getAttachmentIngestionStatus(attachment) {
  if (attachment.errorMessage) {
    return "failed";
  }

  const status = String(
    attachment.ingestion_status || attachment.ingestionStatus || ""
  ).trim();

  if (["queued", "processing", "done", "failed"].includes(status)) {
    return status;
  }

  return attachment.isPending ? "processing" : "done";
}

function getAttachmentIngestionError(attachment) {
  return String(
    attachment.ingestion_error ||
      attachment.ingestionError ||
      attachment.errorMessage ||
      ""
  ).trim();
}

function getPendingAttachmentItems() {
  return Array.from(pendingIngestionJobs.values());
}

function hasActivePendingJobs() {
  for (const job of pendingIngestionJobs.values()) {
    const status = getAttachmentIngestionStatus(job);

    if (status === "queued" || status === "processing") {
      return true;
    }
  }

  return false;
}

function getActivePendingJob() {
  for (const job of pendingIngestionJobs.values()) {
    const status = getAttachmentIngestionStatus(job);

    if (status === "queued" || status === "processing") {
      return job;
    }
  }

  return null;
}

function renderIngestBannerContent() {
  if (isUploading && pendingUploadLabel) {
    ingestBannerEl.hidden = false;
    ingestBannerEl.innerHTML = `
      <div class="ingest-spinner"></div>
      <div class="ingest-banner-text">
        <strong>Uploading ${escapeHtml(pendingUploadLabel)}</strong>
        <span class="ingest-banner-sub">Sending your file to secure storage — chat unlocks once it's indexed.</span>
      </div>`;
    return;
  }

  const activeJob = getActivePendingJob();

  if (!activeJob) {
    ingestBannerEl.hidden = true;
    ingestBannerEl.innerHTML = "";
    return;
  }

  const startedAt = Number(activeJob.startedAt || 0);
  const elapsedMs = startedAt ? Date.now() - startedAt : 0;
  const name = escapeHtml(activeJob.displayName || "your file");
  const lowerName = String(activeJob.displayName || "").toLowerCase();
  const isLikelyScan = lowerName.includes("playbook") || lowerName.includes("onboarding");
  let mainText;
  let subText;

  if (isLikelyScan && elapsedMs >= 30_000) {
    mainText = `Running OCR on <strong>${name}</strong>`;
    subText = "Scanned PDFs need extra processing — usually 1–3 minutes total. Almost there.";
  } else if (elapsedMs >= 25_000) {
    mainText = `Still indexing <strong>${name}</strong>`;
    subText = "Large or complex PDFs take a little longer. Chat unlocks as soon as it's ready.";
  } else {
    mainText = `Indexing <strong>${name}</strong>`;
    subText = "Building a searchable index so you can ask questions about it — usually about 30 seconds.";
  }

  ingestBannerEl.hidden = false;
  ingestBannerEl.innerHTML = `
    <div class="ingest-spinner"></div>
    <div class="ingest-banner-text">
      ${mainText}
      <span class="ingest-banner-sub">${subText}</span>
    </div>`;
}

function updateIngestBanner() {
  renderIngestBannerContent();

  const shouldTick = isUploading || hasActivePendingJobs();

  if (shouldTick && !ingestBannerTickerId) {
    ingestBannerTickerId = setInterval(() => {
      if (!isUploading && !hasActivePendingJobs()) {
        clearInterval(ingestBannerTickerId);
        ingestBannerTickerId = null;
        return;
      }

      renderIngestBannerContent();
    }, 5000);
  } else if (!shouldTick && ingestBannerTickerId) {
    clearInterval(ingestBannerTickerId);
    ingestBannerTickerId = null;
  }
}

function getBubbleParts(bubbleEl) {
  return {
    statusEl: bubbleEl.querySelector(".bubble-status"),
    contentEl: bubbleEl.querySelector(".bubble-content"),
    sourcesEl: bubbleEl.querySelector(".bubble-sources"),
    cursorEl: bubbleEl.querySelector(".cursor")
  };
}

function removeCursor(bubbleEl) {
  const { cursorEl } = getBubbleParts(bubbleEl);

  if (cursorEl) {
    cursorEl.remove();
  }
}

function setBubbleStatus(bubbleEl, text) {
  const { statusEl } = getBubbleParts(bubbleEl);

  if (!statusEl) {
    return;
  }

  if (!text) {
    statusEl.textContent = "";
    statusEl.classList.remove("visible");
    return;
  }

  statusEl.textContent = text;
  statusEl.classList.add("visible");
}

function clearBubbleStatus(bubbleEl) {
  setBubbleStatus(bubbleEl, "");
}

function appendBubble(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `bubble-wrap ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.dataset.raw = text || "";
  bubble.dataset.role = role;

  const meta = document.createElement("div");
  meta.className = "bubble-meta";
  meta.innerHTML = `
    <span class="bubble-author">${role === "assistant" ? "Eneto Guide" : "You"}</span>
    <span class="bubble-time">${getTimeLabel()}</span>
  `;

  const status = document.createElement("div");
  status.className = "bubble-status";

  const content = document.createElement("div");
  content.className = "bubble-content";
  content.innerHTML = text ? formatText(text, []) : "";

  const sources = document.createElement("div");
  sources.className = "bubble-sources";

  bubble.append(meta, status, content);

  if (role === "assistant") {
    const cursor = document.createElement("span");
    cursor.className = "cursor";
    bubble.appendChild(cursor);
  }

  bubble.appendChild(sources);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  updateChatChrome();
  return bubble;
}

function appendTyping() {
  const bubble = appendBubble("assistant", "");
  const { contentEl } = getBubbleParts(bubble);

  bubble.classList.add("is-typing");
  contentEl.innerHTML = `
    <span class="typing-indicator" aria-hidden="true">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </span>
  `;
  setBubbleStatus(bubble, STATUS_MESSAGES.responding);

  return bubble;
}

function appendTextToBubble(bubbleEl, text) {
  bubbleEl.dataset.raw = `${bubbleEl.dataset.raw || ""}${text}`;
  bubbleEl.classList.remove("is-typing");

  // cursor lives outside contentEl as a sibling — innerHTML update does not
  // displace it, so no re-insertion needed.
  const { contentEl } = getBubbleParts(bubbleEl);
  contentEl.innerHTML = formatText(
    bubbleEl.dataset.raw,
    getBubbleCitations(bubbleEl)
  );
}

function getDomainLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_error) {
    return "Source";
  }
}

function parseSourceDate(value) {
  const text = String(value || "").trim();

  if (!text) {
    return null;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildBegFreshnessChip(items) {
  const begItems = items.filter((item) => item.metadataType === "beg-record");

  if (!begItems.length) {
    return null;
  }

  const sourceNames = [
    ...new Set(
      begItems
        .map((item) => String(item.source || "").trim())
        .filter(Boolean)
    )
  ];
  const sourceLabel = sourceNames.length === 1
    ? sourceNames[0]
    : sourceNames.length > 1
      ? "Multiple BEG sources"
      : "BEG source unknown";
  const dates = begItems.map((item) =>
    parseSourceDate(item.last_updated || item.lastUpdated)
  );
  const hasUnknownDate = dates.some((date) => !date);
  const oldestDate = hasUnknownDate
    ? null
    : dates.reduce((oldest, date) => (!oldest || date < oldest ? date : oldest), null);
  const dateLabel = oldestDate ? oldestDate.toISOString().slice(0, 10) : "unknown";
  const daysOld = oldestDate
    ? (Date.now() - oldestDate.getTime()) / (1000 * 60 * 60 * 24)
    : Infinity;
  const isStale = !oldestDate || daysOld > 90;
  const chip = document.createElement("div");
  chip.className = `beg-freshness-chip${isStale ? " is-stale" : " is-current"}`;
  chip.title = "This answer used Eneto's structured BEG funding records.";
  chip.textContent = isStale
    ? `${sourceLabel} · ${dateLabel} · BEG data may be outdated — verify with BAFA/KfW.`
    : `${sourceLabel} · Last updated ${dateLabel}`;

  return chip;
}

function getCitationLabel(citation, number) {
  const page = citation.page ? ` p. ${citation.page}` : "";
  return `[${number}] ${citation.title || "Source"}${page}`;
}

function openCitation(citation) {
  if (!citation) {
    return;
  }

  if ((citation.type === "web" || citation.type === "document") && citation.url) {
    window.open(citation.url, "_blank", "noopener,noreferrer");
    return;
  }

  showCitationPanel(citation);
}

function showCitationPanel(citation) {
  let overlay = document.querySelector(".citation-panel-overlay");

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "citation-panel-overlay";
    overlay.innerHTML = `
      <aside class="citation-panel" role="dialog" aria-modal="true" aria-label="Citation details">
        <button class="citation-panel-close" type="button" aria-label="Close citation details">×</button>
        <div class="citation-panel-body"></div>
      </aside>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (event) => {
      if (
        event.target === overlay ||
        event.target.closest(".citation-panel-close")
      ) {
        overlay.remove();
      }
    });
  }

  const body = overlay.querySelector(".citation-panel-body");
  const sourceName = citation.source || citation.title || "Source";
  const updated = citation.last_updated || citation.retrieved_at || "unknown";
  const page = citation.page ? `Page ${citation.page}` : "Page unknown";
  const typeLabel = citation.type === "beg_record"
    ? "BEG structured record"
    : citation.type === "document"
      ? "Document citation"
      : "Web citation";
  const snippet = citation.snippet || "No excerpt available.";

  body.innerHTML = `
    <span class="citation-panel-type">${formatInline(typeLabel)}</span>
    <h3>${formatInline(citation.title || "Citation")}</h3>
    <p class="citation-panel-meta">${formatInline(sourceName)} · ${formatInline(page)} · ${formatInline(updated)}</p>
    <p class="citation-panel-snippet">${formatInline(snippet)}</p>
    <button class="citation-copy" type="button">Copy citation</button>
  `;

  const copyBtn = body.querySelector(".citation-copy");
  copyBtn.addEventListener("click", async () => {
    const copyText = `${citation.title || "Citation"}\n${page}\n${snippet}`;
    await navigator.clipboard?.writeText(copyText).catch(() => {});
    copyBtn.textContent = "Copied";
    setTimeout(() => {
      copyBtn.textContent = "Copy citation";
    }, 1500);
  });
}

function renderCitationRow(bubbleEl) {
  const citations = getBubbleCitations(bubbleEl);
  const { sourcesEl } = getBubbleParts(bubbleEl);

  if (!sourcesEl) {
    return;
  }

  sourcesEl.querySelector(".citation-row")?.remove();

  if (!citations.length) {
    return;
  }

  const row = document.createElement("div");
  row.className = "citation-row";

  for (const [index, citation] of citations.entries()) {
    const number = index + 1;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `citation-source-chip is-${citation.type}`;
    chip.dataset.citeNumber = String(number);
    chip.textContent = getCitationLabel(citation, number);
    chip.addEventListener("mouseenter", () => {
      bubbleEl
        .querySelectorAll(`.citation-marker[data-cite-number="${number}"]`)
        .forEach((marker) => marker.classList.add("is-highlighted"));
    });
    chip.addEventListener("mouseleave", () => {
      bubbleEl
        .querySelectorAll(`.citation-marker[data-cite-number="${number}"]`)
        .forEach((marker) => marker.classList.remove("is-highlighted"));
    });
    chip.addEventListener("click", () => openCitation(citation));
    row.appendChild(chip);
  }

  sourcesEl.prepend(row);
}

function applyCitationsToBubble(bubbleEl, citations) {
  bubbleEl.dataset.citations = JSON.stringify(Array.isArray(citations) ? citations : []);
  const { contentEl } = getBubbleParts(bubbleEl);

  if (contentEl) {
    contentEl.innerHTML = formatText(
      bubbleEl.dataset.raw || "",
      getBubbleCitations(bubbleEl)
    );
  }

  renderCitationRow(bubbleEl);
}

function appendSourcesToBubble(bubbleEl, sources) {
  const { sourcesEl } = getBubbleParts(bubbleEl);
  const normalizedPayload = Array.isArray(sources)
    ? { label: "Web sources", items: sources }
    : sources;
  const items = Array.isArray(normalizedPayload?.items)
    ? normalizedPayload.items
    : [];
  const labelText = normalizedPayload?.label || "Sources";

  if (!sourcesEl || !items.length) {
    return;
  }

  const begChip = buildBegFreshnessChip(items);

  if (begChip) {
    sourcesEl.appendChild(begChip);
  }

  const label = document.createElement("div");
  label.className = "source-label";
  label.textContent = labelText;
  sourcesEl.appendChild(label);

  const grid = document.createElement("div");
  grid.className = "source-grid";

  for (const source of items) {
    const card = document.createElement(source.url ? "a" : "div");
    card.className = "source-card";
    const retrievalLabel = source.retrievalDate
      ? `Retrieved ${source.retrievalDate}`
      : "";

    if (source.url) {
      card.href = source.url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
    }

    card.innerHTML = `
      <span class="source-domain">${formatInline(getDomainLabel(source.url))}</span>
      <strong class="source-title">${formatInline(source.title || "Untitled source")}</strong>
      ${retrievalLabel ? `<span class="source-retrieved">${formatInline(retrievalLabel)}</span>` : ""}
      <span class="source-snippet">${formatInline(source.snippet || "No summary available.")}</span>
      <span class="source-cta">${formatInline(
        source.cta || (source.url ? "Open source" : "Source unavailable")
      )}</span>
    `;
    grid.appendChild(card);
  }

  sourcesEl.appendChild(grid);
}

function appendWebSearchIndicator(bubbleEl, payload = {}) {
  const { sourcesEl } = getBubbleParts(bubbleEl);

  if (!sourcesEl || sourcesEl.querySelector(".web-search-indicator")) {
    return;
  }

  const indicator = document.createElement("div");
  indicator.className = "web-search-indicator";
  indicator.title =
    payload.reason ||
    "Web search was used automatically because this topic can change frequently.";
  indicator.textContent = "🌐 Web search used for current info";
  sourcesEl.prepend(indicator);
}

function renderAttachments() {
  attachmentRowEl.innerHTML = "";

  const items = [...attachments, ...getPendingAttachmentItems()];

  if (pendingUploadLabel) {
    items.push({
      id: "__pending__",
      displayName: pendingUploadLabel,
      isPending: true
    });
  }

  if (!items.length) {
    return;
  }

  for (const attachment of items) {
    const status = getAttachmentIngestionStatus(attachment);
    const statusError = getAttachmentIngestionError(attachment);
    const chip = document.createElement("div");
    chip.className = `attachment-chip${attachment.isPending ? " is-pending" : ""} is-${status}`;
    chip.dataset.attachmentId = attachment.id || "";

    const statusEl = document.createElement("span");
    statusEl.className = `attachment-status-icon is-${status}`;
    statusEl.setAttribute("aria-label", status);

    if (status === "failed") {
      statusEl.textContent = "!";
      statusEl.title = statusError || "Indexing failed. Try re-uploading.";
      statusEl.tabIndex = 0;
      statusEl.role = "button";
      statusEl.addEventListener("click", () => {
        setHintOverride(statusEl.title);
      });
      statusEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setHintOverride(statusEl.title);
        }
      });
    } else if (status === "done") {
      statusEl.textContent = "✓";
    } else {
      statusEl.setAttribute("aria-label", "Processing");
    }

    const copy = document.createElement("div");
    copy.className = "attachment-copy";

    const title = document.createElement("strong");
    title.className = "attachment-title";
    title.textContent = attachment.displayName || "Uploaded file";

    const meta = document.createElement("span");
    meta.className = "attachment-meta";

    const metaParts = [];

    if (attachment.mimeType) {
      metaParts.push(attachment.mimeType);
    }

    const sizeLabel = formatBytes(attachment.sizeBytes);

    if (sizeLabel) {
      metaParts.push(sizeLabel);
    }

    if (attachment.isPending) {
      meta.textContent = getPendingAttachmentStatus(attachment);
    } else {
      meta.textContent =
        status === "done"
          ? ["Ready", ...metaParts].join(" · ")
          : metaParts.join(" · ") || "Ready";
    }

    copy.append(title, meta);
    chip.appendChild(statusEl);
    chip.appendChild(copy);

    if (!attachment.isPending || status === "failed") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "attachment-remove";
      removeBtn.textContent = "Remove";
      removeBtn.disabled = isUploading || isStreaming;
      removeBtn.addEventListener("click", () => {
        if (status === "failed") {
          pendingIngestionJobs.delete(attachment.id);
          renderAttachments();
          updateComposerState();
          return;
        }

        removeAttachment(attachment.id);
      });
      chip.appendChild(removeBtn);
    }

    attachmentRowEl.appendChild(chip);
  }
}

function finalizeAssistantBubble(bubbleEl) {
  bubbleEl.classList.remove("is-typing");
  removeCursor(bubbleEl);
  clearBubbleStatus(bubbleEl);
}

function finishStream() {
  if (scrollRafId !== null) {
    cancelAnimationFrame(scrollRafId);
    scrollRafId = null;
  }
  isStreaming = false;
  updateComposerState();
  inputEl.focus();
}

function clearWelcomeState() {
  const welcomeState = messagesEl.querySelector(".welcome-state");

  if (welcomeState) {
    welcomeState.remove();
  }
}

function getSessionTitleFromDom() {
  const firstUserBubble = messagesEl.querySelector(".bubble[data-role='user']");
  const raw = firstUserBubble?.dataset?.raw || "";
  const title = raw.replace(/\s+/g, " ").trim() || "New chat";
  return title.length > 48 ? `${title.slice(0, 48).trim()}...` : title;
}

function updateChatChrome() {
  const hasMessages = Boolean(messagesEl.querySelector(".bubble-wrap"));
  chatTopbarEl.hidden = !hasMessages;
  mobileSidebarFabEl.hidden = hasMessages;
  chatTitleEl.textContent = hasMessages ? getSessionTitleFromDom() : "New chat";
}

function buildStarterChip(prompt) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "starter-chip";
  button.textContent = prompt;
  button.addEventListener("click", () => {
    if (isStreaming || isUploading) {
      return;
    }

    inputEl.value = prompt;
    autoResizeTextarea();
    updateComposerState();
    sendMessage();
  });
  return button;
}

function showWelcome() {
  messagesEl.innerHTML = "";

  const welcome = document.createElement("section");
  welcome.className = "welcome-state";
  welcome.innerHTML = `
    <h2 class="welcome-title">Ask about Eneto products, funding, or your documents.</h2>
  `;

  const chipGroup = document.createElement("div");
  chipGroup.className = "welcome-chip-group";

  for (const prompt of STARTER_PROMPTS) {
    chipGroup.appendChild(buildStarterChip(prompt));
  }

  welcome.appendChild(chipGroup);
  messagesEl.appendChild(welcome);
  updateChatChrome();
  scrollToBottom();
}

function handleStatus(type, bubbleEl) {
  setBubbleStatus(bubbleEl, STATUS_MESSAGES[type] || "Working...");
}

function showErrorInBubble(bubbleEl, message) {
  bubbleEl.dataset.raw = message;
  bubbleEl.classList.remove("is-typing");
  const { contentEl } = getBubbleParts(bubbleEl);
  contentEl.innerHTML = formatText(message);
  finalizeAssistantBubble(bubbleEl);
}

function getRelativeTimeLabel(value) {
  const date = value ? new Date(value) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }

  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.floor(diffMs / 60_000));

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return `${hours}h ago`;
  }

  if (hours < 48) {
    return "Yesterday";
  }

  return `${Math.floor(hours / 24)}d ago`;
}

function renderRecentChats(sessions = []) {
  recentChatsEl.innerHTML = "";

  if (!sessions.length) {
    const empty = document.createElement("div");
    empty.className = "recent-empty";
    empty.textContent = "No recent chats yet";
    recentChatsEl.appendChild(empty);
    return;
  }

  for (const session of sessions) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `recent-chat${session.id === sessionId ? " is-active" : ""}`;
    item.innerHTML = `
      <span>${escapeHtml(session.title || "New chat")}</span>
      <small>${escapeHtml(getRelativeTimeLabel(session.updatedAt))}</small>
    `;
    item.addEventListener("click", () => loadSession(session.id));
    recentChatsEl.appendChild(item);
  }
}

async function loadRecentChats() {
  renderRecentChats([]);

  try {
    const response = await fetch("/api/sessions");

    if (!response.ok) {
      return;
    }

    const data = await response.json();
    renderRecentChats(Array.isArray(data.sessions) ? data.sessions : []);
  } catch (_error) {
    renderRecentChats([]);
  }
}

function renderTurns(turns = []) {
  messagesEl.innerHTML = "";

  if (!turns.length) {
    showWelcome();
    return;
  }

  for (const turn of turns) {
    appendBubble(turn.role === "assistant" ? "assistant" : "user", turn.content || "");
  }

  updateChatChrome();
  scrollToBottom();
}

async function loadSession(nextSessionId) {
  if (!nextSessionId || isStreaming || isUploading) {
    return;
  }

  try {
    const response = await fetch(`/api/session/${encodeURIComponent(nextSessionId)}`);
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || "Could not load that chat.");
    }

    sessionId = nextSessionId;
    sessionStorage.setItem(SESSION_KEY, sessionId);
    attachments = Array.isArray(data.attachments) ? data.attachments : [];
    pendingIngestionJobs.clear();
    renderTurns(Array.isArray(data.turns) ? data.turns : []);
    renderAttachments();
    updateComposerState();
    closeSidebar();
    void loadRecentChats();
  } catch (error) {
    setHintOverride(error.message || "Could not load that chat.");
  }
}

function startNewChat() {
  clearTimeout(hintOverrideTimerId);
  sessionId = crypto.randomUUID();
  sessionStorage.setItem(SESSION_KEY, sessionId);
  attachments = [];
  for (const documentId of ingestPollTimeoutIds.keys()) {
    stopIngestionPolling(documentId);
  }
  pendingIngestionJobs.clear();
  pendingUploadLabel = "";
  hintOverride = "";
  renderAttachments();
  showWelcome();
  updateComposerState();
  closeSidebar();
  void loadRecentChats();
}

function openSidebar() {
  document.body.classList.add("sidebar-open");
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
}

function stopIngestionPolling(documentId) {
  const timeoutId = ingestPollTimeoutIds.get(documentId);

  if (timeoutId) {
    clearTimeout(timeoutId);
    ingestPollTimeoutIds.delete(documentId);
  }
}

function scheduleIngestionPolling(jobId, documentId) {
  stopIngestionPolling(documentId);

  let networkErrorCount = 0;
  const MAX_NETWORK_ERRORS = 4;

  const poll = async () => {
    try {
      const response = await fetch(
        `/api/ingest/status/${encodeURIComponent(jobId)}`
      );
      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(data?.error || "Processing failed.");
      }

      // Reset transient error count on any successful response
      networkErrorCount = 0;

      const pendingAttachment = pendingIngestionJobs.get(documentId);

      if (!pendingAttachment) {
        stopIngestionPolling(documentId);
        return;
      }

      if (data?.status === "done") {
        pendingIngestionJobs.delete(documentId);
        stopIngestionPolling(documentId);
        await loadSessionAttachments();
        renderAttachments();
        updateComposerState();
        return;
      }

      if (data?.status === "failed") {
        pendingIngestionJobs.set(documentId, {
          ...pendingAttachment,
          ingestion_status: "failed",
          ingestion_error:
            data?.ingestion_error ||
            data?.errorMessage ||
            "Indexing failed. Remove and try again.",
          errorMessage:
            data?.ingestion_error ||
            data?.errorMessage ||
            "Indexing failed. Remove and try again."
        });
        stopIngestionPolling(documentId);
        renderAttachments();
        updateComposerState();
        return;
      }

      // Still processing — update display and continue polling
      pendingIngestionJobs.set(documentId, {
        ...pendingAttachment,
        ingestion_status: data?.ingestion_status || data?.status || "processing",
        ingestion_error: data?.ingestion_error || null,
        errorMessage: ""
      });
      renderAttachments();
      updateComposerState();

      const timeoutId = setTimeout(poll, INGEST_POLL_INTERVAL_MS);
      ingestPollTimeoutIds.set(documentId, timeoutId);
    } catch (error) {
      const pendingAttachment = pendingIngestionJobs.get(documentId);

      if (!pendingAttachment) {
        stopIngestionPolling(documentId);
        return;
      }

      networkErrorCount += 1;

      // Retry up to MAX_NETWORK_ERRORS times before giving up
      if (networkErrorCount < MAX_NETWORK_ERRORS) {
        const retryDelay = Math.min(INGEST_POLL_INTERVAL_MS * networkErrorCount, 8000);
        const timeoutId = setTimeout(poll, retryDelay);
        ingestPollTimeoutIds.set(documentId, timeoutId);
        return;
      }

      pendingIngestionJobs.set(documentId, {
        ...pendingAttachment,
        ingestion_status: "failed",
        ingestion_error: "Could not reach the server. Remove and try again.",
        errorMessage: "Could not reach the server. Remove and try again."
      });
      stopIngestionPolling(documentId);
      renderAttachments();
      updateComposerState();
    }
  };

  void poll();
}

async function loadSessionAttachments() {
  try {
    const response = await fetch(
      `/api/attachments?sessionId=${encodeURIComponent(sessionId)}&refresh=1`
    );

    if (!response.ok) {
      return;
    }

    const data = await response.json();
    attachments = Array.isArray(data.attachments) ? data.attachments : [];

    // Clear any pending chips that are now confirmed in the session
    const confirmedIds = new Set(attachments.map((a) => a.id));
    for (const [id] of pendingIngestionJobs.entries()) {
      if (confirmedIds.has(id)) {
        stopIngestionPolling(id);
        pendingIngestionJobs.delete(id);
      }
    }

    renderAttachments();
    updateComposerState();
  } catch (_error) {
    // Ignore attachment bootstrap failures and keep the chat usable.
  }
}

async function uploadSelectedFile(file) {
  if (!file || isStreaming || isUploading) {
    return;
  }

  isUploading = true;
  pendingUploadLabel = file.name;
  renderAttachments();
  updateComposerState();

  try {
    const formData = new FormData();
    formData.append("sessionId", sessionId);
    formData.append("file", file);

    const response = await fetch("/api/upload", {
      method: "POST",
      body: formData
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || "Upload failed.");
    }

    if (data?.jobId && data?.documentId) {
      // Remove any previous failed chip for the same filename before adding the new one
      for (const [existingId, existing] of pendingIngestionJobs.entries()) {
        if (
          existing.displayName === file.name &&
          (existing.errorMessage || existing.id !== data.documentId)
        ) {
          stopIngestionPolling(existingId);
          pendingIngestionJobs.delete(existingId);
        }
      }

      pendingIngestionJobs.set(data.documentId, {
        id: data.documentId,
        jobId: data.jobId,
        displayName: file.name,
        mimeType: file.type || "application/pdf",
        sizeBytes: file.size,
        startedAt: Date.now(),
        isPending: true,
        ingestion_status: "queued",
        ingestion_error: null,
        errorMessage: ""
      });
      scheduleIngestionPolling(data.jobId, data.documentId);
    } else {
      attachments = Array.isArray(data?.attachments) ? data.attachments : attachments;
    }

    renderAttachments();
  } catch (error) {
    setHintOverride(error.message || "Upload failed.");
  } finally {
    isUploading = false;
    pendingUploadLabel = "";
    renderAttachments();
    updateComposerState();
  }
}

async function removeAttachment(attachmentId) {
  if (!attachmentId || isStreaming || isUploading) {
    return;
  }

  isUploading = true;
  updateComposerState();
  renderAttachments();

  try {
    const response = await fetch(
      `/api/attachments/${encodeURIComponent(attachmentId)}`,
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ sessionId })
      }
    );

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(data?.error || "Could not remove the file.");
    }

    attachments = Array.isArray(data?.attachments) ? data.attachments : [];
    renderAttachments();
  } catch (error) {
    setHintOverride(error.message || "Could not remove the file.");
  } finally {
    isUploading = false;
    renderAttachments();
    updateComposerState();
  }
}

async function sendMessage() {
  const text = inputEl.value.trim();

  if (!text || isStreaming || isUploading || hasActivePendingJobs()) {
    return;
  }

  clearWelcomeState();
  isStreaming = true;
  updateComposerState();

  inputEl.value = "";
  inputEl.style.height = "auto";

  appendBubble("user", text);
  const botEl = appendTyping();
  scrollToBottom();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: text,
        sessionId,
        webSearchMode
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      showErrorInBubble(
        botEl,
        errorData?.error || "Something went wrong. Please try again."
      );
      finishStream();
      scrollToBottom();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamFinished = false;

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line.startsWith("data:")) {
          continue;
        }

        let event;

        try {
          event = JSON.parse(line.slice(5).trim());
        } catch (_error) {
          continue;
        }

        if (event.type === "status") {
          handleStatus(event.content, botEl);
          scheduleScroll();
          continue;
        }

        if (event.type === "text") {
          appendTextToBubble(botEl, event.content);
          scheduleScroll();
          continue;
        }

        if (event.type === "sources") {
          appendSourcesToBubble(botEl, event.content);
          scheduleScroll();
          continue;
        }

        if (event.type === "citations") {
          applyCitationsToBubble(botEl, event.content);
          scheduleScroll();
          continue;
        }

        if (event.type === "web_search_indicator") {
          appendWebSearchIndicator(botEl, event.content);
          scheduleScroll();
          continue;
        }

        if (event.type === "done") {
          streamFinished = true;
          finalizeAssistantBubble(botEl);
          finishStream();
          void loadSessionAttachments();
          scrollToBottom();
          continue;
        }

        if (event.type === "error") {
          streamFinished = true;
          showErrorInBubble(botEl, event.content);
          finishStream();
          void loadSessionAttachments();
          scrollToBottom();
        }
      }
    }

    if (!streamFinished && isStreaming) {
      finalizeAssistantBubble(botEl);
      finishStream();
      void loadSessionAttachments();
      scrollToBottom();
    }
  } catch (_error) {
    showErrorInBubble(
      botEl,
      "I couldn’t reach the server just now. Please try again."
    );
    finishStream();
    void loadSessionAttachments();
    scrollToBottom();
  }
}

inputEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

inputEl.addEventListener("input", () => {
  autoResizeTextarea();
  updateComposerState();
});

sendBtn.addEventListener("click", () => {
  sendMessage();
});

chatMenuBtn.addEventListener("click", () => {
  chatMenuPopover.hidden = !chatMenuPopover.hidden;
});

fileBtn.addEventListener("click", () => {
  if (fileBtn.disabled) {
    return;
  }

  fileInputEl.click();
});

webSearchToggleEl.addEventListener("click", () => {
  if (webSearchToggleEl.disabled) {
    return;
  }

  cycleWebSearchMode();
});

fileInputEl.addEventListener("change", () => {
  const [file] = fileInputEl.files || [];
  fileInputEl.value = "";

  if (!file) {
    return;
  }

  uploadSelectedFile(file);
});

resetBtn.addEventListener("click", async () => {
  if (isStreaming || isUploading) {
    return;
  }

  startNewChat();
});

sidebarToggleEl.addEventListener("click", openSidebar);
mobileSidebarFabEl.addEventListener("click", openSidebar);
sidebarOverlayEl.addEventListener("click", closeSidebar);

messagesEl.addEventListener("click", (event) => {
  const marker = event.target.closest(".citation-marker");

  if (!marker) {
    return;
  }

  const bubbleEl = marker.closest(".bubble");
  const citation = getCitationByNumber(
    getBubbleCitations(bubbleEl),
    Number(marker.dataset.citeNumber || 0)
  );
  openCitation(citation);
});

showWelcome();
renderAttachments();
loadSessionAttachments();
loadRecentChats();
updateComposerState();
