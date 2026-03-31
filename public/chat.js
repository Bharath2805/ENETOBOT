const SESSION_KEY = "chatbot-session-id";
const WEB_SEARCH_TOGGLE_KEY = "chatbot-web-search-enabled";
const MAX_TEXTAREA_HEIGHT = 140;
const MAX_SESSION_FILES = 20;
const STARTER_PROMPTS = [
  "What does Eneto do in simple terms?",
  "Show me the latest Eneto updates. search web",
  "How quickly can a team get started with Eneto?",
  "What is the best next step if I want a demo?"
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
const starterRowEl = document.getElementById("starter-row");
const attachmentRowEl = document.getElementById("attachment-row");
const inputHintEl = document.getElementById("input-hint");

let sessionId = getOrCreateSessionId();
let attachments = [];
let isWebSearchEnabled = getStoredWebSearchPreference();
let isStreaming = false;
let isUploading = false;
let hintOverride = "";
let hintOverrideTimerId = null;
let pendingUploadLabel = "";
let scrollRafId = null;

function getOrCreateSessionId() {
  const existingId = sessionStorage.getItem(SESSION_KEY);

  if (existingId) {
    return existingId;
  }

  const newId = crypto.randomUUID();
  sessionStorage.setItem(SESSION_KEY, newId);
  return newId;
}

function getStoredWebSearchPreference() {
  return localStorage.getItem(WEB_SEARCH_TOGGLE_KEY) === "true";
}

function getTimeLabel() {
  return new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function updateComposerState() {
  sendBtn.disabled = !inputEl.value.trim() || isStreaming || isUploading;
  fileBtn.disabled =
    isStreaming || isUploading || attachments.length >= MAX_SESSION_FILES;
  webSearchToggleEl.disabled = isStreaming || isUploading;
  webSearchToggleEl.setAttribute(
    "aria-checked",
    isWebSearchEnabled ? "true" : "false"
  );
  webSearchToggleEl.classList.toggle("is-on", isWebSearchEnabled);
  webSearchStatusEl.textContent = isWebSearchEnabled ? "Always on" : "Off";
  webSearchStatusEl.classList.toggle("is-on", isWebSearchEnabled);

  if (hintOverride) {
    inputHintEl.textContent = hintOverride;
    return;
  }

  const parts = [
    "Enter to send",
    "Shift+Enter for new line",
    "Add “search web” for a live lookup"
  ];

  if (isUploading && pendingUploadLabel) {
    parts.push(`Uploading ${pendingUploadLabel}...`);
  } else if (isWebSearchEnabled) {
    parts.push("Web search is on for every message");
  } else if (attachments.length) {
    parts.push(
      `${attachments.length} attached file${attachments.length === 1 ? "" : "s"} in this chat`
    );
  } else {
    parts.push("Attach PDFs, Office docs, text files, or images");
  }

  inputHintEl.textContent = parts.join(" · ");
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

function formatInline(text) {
  return escapeHtml(text)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function formatText(text) {
  const lines = String(text || "").split("\n");
  const htmlParts = [];
  let paragraphLines = [];
  let listType = null;

  function flushParagraph() {
    if (!paragraphLines.length) {
      return;
    }

    htmlParts.push(`<p>${paragraphLines.map(formatInline).join("<br>")}</p>`);
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
      htmlParts.push(`<h3>${formatInline(line.replace(/^###\s+/, ""))}</h3>`);
      continue;
    }

    if (/^##\s+/.test(line)) {
      flushParagraph();
      closeList();
      htmlParts.push(`<h2>${formatInline(line.replace(/^##\s+/, ""))}</h2>`);
      continue;
    }

    if (/^#\s+/.test(line)) {
      flushParagraph();
      closeList();
      htmlParts.push(`<h1>${formatInline(line.replace(/^#\s+/, ""))}</h1>`);
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

      htmlParts.push(`<li>${formatInline(unorderedMatch[1])}</li>`);
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

      htmlParts.push(`<li>${formatInline(orderedMatch[1])}</li>`);
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
  content.innerHTML = text ? formatText(text) : "";

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
  contentEl.innerHTML = formatText(bubbleEl.dataset.raw);
}

function getDomainLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (_error) {
    return "Source";
  }
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

  const label = document.createElement("div");
  label.className = "source-label";
  label.textContent = labelText;
  sourcesEl.appendChild(label);

  const grid = document.createElement("div");
  grid.className = "source-grid";

  for (const source of items) {
    const card = document.createElement(source.url ? "a" : "div");
    card.className = "source-card";

    if (source.url) {
      card.href = source.url;
      card.target = "_blank";
      card.rel = "noopener noreferrer";
    }

    card.innerHTML = `
      <span class="source-domain">${formatInline(getDomainLabel(source.url))}</span>
      <strong class="source-title">${formatInline(source.title || "Untitled source")}</strong>
      <span class="source-snippet">${formatInline(source.snippet || "No summary available.")}</span>
      <span class="source-cta">${formatInline(
        source.cta || (source.url ? "Open source" : "Source unavailable")
      )}</span>
    `;
    grid.appendChild(card);
  }

  sourcesEl.appendChild(grid);
}

function renderAttachments() {
  attachmentRowEl.innerHTML = "";

  const items = [...attachments];

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
    const chip = document.createElement("div");
    chip.className = `attachment-chip${attachment.isPending ? " is-pending" : ""}`;

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

    meta.textContent = attachment.isPending
      ? "Uploading and indexing for retrieval..."
      : metaParts.join(" · ") || "Ready for this chat";

    copy.append(title, meta);
    chip.appendChild(copy);

    if (!attachment.isPending) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "attachment-remove";
      removeBtn.textContent = "Remove";
      removeBtn.disabled = isUploading || isStreaming;
      removeBtn.addEventListener("click", () => {
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

function renderStarterRow() {
  starterRowEl.innerHTML = "";

  for (const prompt of STARTER_PROMPTS) {
    starterRowEl.appendChild(buildStarterChip(prompt));
  }
}

function showWelcome() {
  messagesEl.innerHTML = "";

  const welcome = document.createElement("section");
  welcome.className = "welcome-state";
  welcome.innerHTML = `
    <span class="welcome-kicker">Website assistant</span>
    <h2 class="welcome-title">Answers that feel clear, current, and easy to act on.</h2>
    <p class="welcome-copy">
      Ask about Eneto, product capabilities, onboarding, live updates, uploaded documents,
      or the best next step. Turn on <code>Web search</code> for live lookups on every
      message, or add <code>search web</code> only when you need it.
    </p>
  `;

  const chipGroup = document.createElement("div");
  chipGroup.className = "welcome-chip-group";

  for (const prompt of STARTER_PROMPTS) {
    chipGroup.appendChild(buildStarterChip(prompt));
  }

  welcome.appendChild(chipGroup);
  messagesEl.appendChild(welcome);
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

async function loadSessionAttachments() {
  try {
    const response = await fetch(
      `/api/attachments?sessionId=${encodeURIComponent(sessionId)}`
    );

    if (!response.ok) {
      return;
    }

    const data = await response.json();
    attachments = Array.isArray(data.attachments) ? data.attachments : [];
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

    attachments = Array.isArray(data?.attachments) ? data.attachments : attachments;
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

  if (!text || isStreaming || isUploading) {
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
        forceWebSearch: isWebSearchEnabled
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

  isWebSearchEnabled = !isWebSearchEnabled;
  localStorage.setItem(
    WEB_SEARCH_TOGGLE_KEY,
    isWebSearchEnabled ? "true" : "false"
  );
  updateComposerState();
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

  try {
    await fetch("/api/reset", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sessionId })
    });
  } catch (_error) {
    // Ignore reset errors and continue with a fresh local session.
  }

  clearTimeout(hintOverrideTimerId);
  sessionId = crypto.randomUUID();
  sessionStorage.setItem(SESSION_KEY, sessionId);
  attachments = [];
  pendingUploadLabel = "";
  hintOverride = "";
  renderAttachments();
  showWelcome();
  updateComposerState();
});

renderStarterRow();
showWelcome();
renderAttachments();
loadSessionAttachments();
updateComposerState();
