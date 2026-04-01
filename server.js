const express = require("express");
const { randomUUID } = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const XLSX = require("xlsx");
const cors = require("cors");
const multer = require("multer");
const dotenv = require("dotenv");
const {
  FileState,
  GoogleGenAI,
  createPartFromUri,
  createUserContent
} = require("@google/genai");

const config = require("./config");
const firestoreLib = require("./lib/firestore");
const {
  OFFICIAL_REFERENCE_DOMAINS,
  SYSTEM_PROMPT,
  classifyRetrieval,
  buildWebSearchRequest,
  buildPrompt,
  buildSummaryPrompt
} = require("./prompt");

if (!process.env.VERCEL) {
  dotenv.config({ path: path.join(__dirname, ".env.local") });
  dotenv.config({ path: path.join(__dirname, ".env") });
}

const app = express();
const publicDir = path.join(__dirname, "public");
const geminiApiKey =
  process.env.GEMINI_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GOOGLE_API ||
  "";
const tavilyApiKey =
  process.env.TAVILY_API_KEY ||
  process.env.TAVILY_API ||
  "";
const genAI = new GoogleGenAI({ apiKey: geminiApiKey });
const sessionCache = new Map();
const sessionCacheTouchedAt = new Map();
const rateLimitBuckets = new Map();
const uploadRateLimitBuckets = new Map();
const SESSION_CACHE_TTL_MS = 30_000;
let globalStoreConfig = null;
let globalStoreLoadedAt = 0;
const GLOBAL_STORE_TTL_MS = 5 * 60_000;
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => {
      callback(null, os.tmpdir());
    },
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname || "");
      const uniqueName = `chatboteneto-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}${extension}`;
      callback(null, uniqueName);
    }
  }),
  limits: {
    files: 1,
    fileSize: config.MAX_UPLOAD_BYTES
  }
});

const FILE_SEARCH_SUPPORTED_MIME_TYPES = new Set([
  "application/json",
  "application/msword",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/xml",
  "application/zip",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/tsv",
  "text/xml",
  "text/yaml"
]);

const DIRECT_MEDIA_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);

const INLINE_LONG_CONTEXT_MIME_TYPES = new Set([
  "application/json",
  "application/pdf",
  "application/xml",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
  "text/tab-separated-values",
  "text/tsv",
  "text/xml",
  "text/yaml"
]);

const MIME_TYPE_BY_EXTENSION = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".tsv": "text/tab-separated-values",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".zip": "application/zip"
};

const SPREADSHEET_MIME_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
]);

app.use(cors());
app.use(express.json());
app.get("/favicon.ico", (_req, res) => {
  res.sendFile(path.join(publicDir, "favicon.svg"));
});
app.use(express.static(publicDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function supportsInlineLongContextMimeType(mimeType) {
  return INLINE_LONG_CONTEXT_MIME_TYPES.has(String(mimeType || "").trim());
}

function isSpreadsheetMimeType(mimeType) {
  return SPREADSHEET_MIME_TYPES.has(String(mimeType || "").trim());
}

function isFileFocusedQuestion(message) {
  return /\b(file|document|attachment|attached|upload(?:ed)?|sheet|spreadsheet|workbook|excel|csv|xlsx|xls|docx|doc|pdf|proposal|quote)\b/i.test(
    String(message || "")
  );
}

function toDocumentResourceName(fileSearchStoreName, documentName) {
  if (!documentName) {
    return "";
  }

  if (documentName.includes("/")) {
    return documentName;
  }

  return `${fileSearchStoreName}/documents/${documentName}`;
}

async function getGlobalStoreConfig() {
  if (globalStoreConfig && Date.now() - globalStoreLoadedAt < GLOBAL_STORE_TTL_MS) {
    return globalStoreConfig;
  }

  const appConfig = await firestoreLib.getAppConfig();
  globalStoreConfig = {
    storeName: appConfig?.globalFileSearchStoreName || null,
    documents: Array.isArray(appConfig?.globalDocuments) ? appConfig.globalDocuments : [],
    begManufacturers: Array.isArray(appConfig?.begManufacturers)
      ? appConfig.begManufacturers
      : [],
    begRecordCount: Number(appConfig?.begRecordCount || 0)
  };
  globalStoreLoadedAt = Date.now();
  return globalStoreConfig;
}

function normalizeForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenizeForRanking(value) {
  return normalizeForMatch(value)
    .split(" ")
    .filter((token) => token.length > 1);
}

function scoreTextAgainstQuery(query, ...fields) {
  const queryTokens = [...new Set(tokenizeForRanking(query))];
  const haystack = normalizeForMatch(fields.join(" "));

  if (!queryTokens.length || !haystack) {
    return 0;
  }

  let score = 0;

  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += token.length >= 4 ? 3 : 1;
    }
  }

  const normalizedQuery = normalizeForMatch(query);

  if (normalizedQuery && haystack.includes(normalizedQuery)) {
    score += 8;
  }

  return score;
}

function rerankItems(query, items, getText, extraScore) {
  return [...items]
    .map((item, index) => ({
      item,
      index,
      score:
        scoreTextAgainstQuery(query, getText(item)) +
        (typeof extraScore === "function" ? extraScore(item) : 0)
    }))
    .sort((left, right) => {
      if (right.score === left.score) {
        return left.index - right.index;
      }

      return right.score - left.score;
    })
    .map((entry) => entry.item);
}

function detectHeatPumpType(message) {
  const normalizedMessage = normalizeForMatch(message);

  if (normalizedMessage.includes("luft wasser")) {
    return "Luft-Wasser";
  }

  if (normalizedMessage.includes("sole wasser")) {
    return "Sole-Wasser";
  }

  if (normalizedMessage.includes("wasser wasser")) {
    return "Wasser-Wasser";
  }

  if (normalizedMessage.includes("luft luft")) {
    return "Luft-Luft";
  }

  if (normalizedMessage.includes("abluft wasser")) {
    return "Abluft-Wasser";
  }

  return "";
}

function buildManufacturerAliases(name) {
  const normalizedName = normalizeForMatch(name);
  const aliases = new Set([normalizedName]);
  const companySuffixes = [
    " gmbh",
    " ag",
    " bv",
    " b v",
    " b v ",
    " ltd",
    " llc",
    " kg",
    " inc",
    " aps",
    " oy",
    " sas",
    " spa",
    " srl",
    " as"
  ];
  let trimmed = normalizedName;

  for (const suffix of companySuffixes) {
    if (trimmed.endsWith(suffix)) {
      trimmed = trimmed.slice(0, -suffix.length).trim();
      aliases.add(trimmed);
    }
  }

  const words = trimmed.split(" ").filter(Boolean);

  if (words[0]) {
    aliases.add(words[0]);
  }

  if (words.length >= 2) {
    aliases.add(words.slice(0, 2).join(" "));
  }

  return [...aliases].filter(Boolean);
}

function findManufacturerMatch(message, manufacturers) {
  const normalizedMessage = normalizeForMatch(message);
  let bestMatch = null;

  for (const manufacturer of manufacturers) {
    for (const alias of buildManufacturerAliases(manufacturer)) {
      if (!alias || !normalizedMessage.includes(alias)) {
        continue;
      }

      const score = alias.length + (alias === normalizeForMatch(manufacturer) ? 4 : 0);

      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          displayName: manufacturer,
          manufacturerNormalized: normalizeForMatch(manufacturer),
          alias,
          score
        };
      }
    }
  }

  return bestMatch;
}

function extractModelQuery(message, manufacturerMatch, heatPumpType) {
  let cleaned = normalizeForMatch(message);
  const stopPhrases = [
    "is",
    "are",
    "beg",
    "bafa",
    "kfw",
    "eligible",
    "forderung",
    "forderfahig",
    "forderfaehig",
    "gelistet",
    "listed",
    "modell",
    "model",
    "warmepumpe",
    "heat pump",
    "heat",
    "pump",
    "ist",
    "sind",
    "fur",
    "for",
    "in",
    "the",
    "a",
    "an",
    "under"
  ];

  if (manufacturerMatch?.alias) {
    cleaned = cleaned.replace(manufacturerMatch.alias, " ");
  }

  if (heatPumpType) {
    cleaned = cleaned.replace(normalizeForMatch(heatPumpType), " ");
  }

  for (const phrase of stopPhrases) {
    cleaned = cleaned.replace(new RegExp(`\\b${phrase}\\b`, "g"), " ");
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}


function createDefaultSession() {
  return {
    attachments: [],
    fileSearchStoreName: null,
    turns: [],
    summary: null
  };
}

function normalizeSession(session) {
  return {
    attachments: Array.isArray(session?.attachments) ? session.attachments : [],
    fileSearchStoreName: session?.fileSearchStoreName || null,
    turns: Array.isArray(session?.turns) ? session.turns : [],
    summary: session?.summary || null
  };
}

async function saveSession(sessionId, session) {
  await firestoreLib.saveSession(sessionId, session);
  sessionCache.set(sessionId, session);
  sessionCacheTouchedAt.set(sessionId, Date.now());
  return session;
}

async function getSession(sessionId, options = {}) {
  const forceRefresh = options?.forceRefresh === true;
  const cachedSession = sessionCache.get(sessionId);
  const cachedAt = sessionCacheTouchedAt.get(sessionId) || 0;

  if (
    !forceRefresh &&
    cachedSession &&
    Date.now() - cachedAt < SESSION_CACHE_TTL_MS
  ) {
    return cachedSession;
  }

  const storedSession = await firestoreLib.getSession(sessionId);
  const session = storedSession
    ? normalizeSession(storedSession)
    : createDefaultSession();

  if (!storedSession) {
    await firestoreLib.saveSession(sessionId, session);
  }

  sessionCache.set(sessionId, session);
  sessionCacheTouchedAt.set(sessionId, Date.now());
  return session;
}

function isOverLimit(bucket, sessionId, maxRequestsPerMinute) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const recentRequests = (bucket.get(sessionId) || []).filter(
    (timestamp) => timestamp >= windowStart
  );

  recentRequests.push(now);
  bucket.set(sessionId, recentRequests);

  return recentRequests.length > maxRequestsPerMinute;
}

function isRateLimited(sessionId) {
  return isOverLimit(rateLimitBuckets, sessionId, config.RATE_LIMIT_RPM);
}

function isUploadRateLimited(sessionId) {
  return isOverLimit(
    uploadRateLimitBuckets,
    sessionId,
    config.UPLOAD_RATE_LIMIT_RPM
  );
}

function getUploadRateLimitKey(req, sessionId) {
  const forwardedForHeader = req.headers["x-forwarded-for"];
  const forwardedFor =
    typeof forwardedForHeader === "string"
      ? forwardedForHeader.split(",")[0].trim()
      : Array.isArray(forwardedForHeader)
        ? String(forwardedForHeader[0] || "").trim()
        : "";

  return forwardedFor || req.ip || sessionId;
}

function resolveUploadDescriptor(file) {
  const extension = path.extname(file.originalname || "").toLowerCase();
  const candidates = [file.mimetype, MIME_TYPE_BY_EXTENSION[extension]].filter(
    Boolean
  );
  const mimeType = candidates[0] || null;

  if (!mimeType) {
    return null;
  }

  if (FILE_SEARCH_SUPPORTED_MIME_TYPES.has(mimeType)) {
    return {
      mimeType,
      strategy: "document"
    };
  }

  if (DIRECT_MEDIA_MIME_TYPES.has(mimeType)) {
    return {
      mimeType,
      strategy: "media"
    };
  }

  return null;
}

function serializeMediaFile(file, fallbackName) {
  const name = String(file?.name || "").trim();

  return {
    id: name.replace(/^files\//, ""),
    name,
    displayName: String(file?.displayName || fallbackName || "Uploaded file"),
    mimeType: String(file?.mimeType || "").trim(),
    sizeBytes: Number(file?.sizeBytes || 0),
    expirationTime: String(file?.expirationTime || "").trim(),
    uri: String(file?.uri || "").trim(),
    strategy: "media"
  };
}

async function convertSpreadsheetToTextFile(file) {
  let workbook;

  try {
    workbook = XLSX.readFile(file.path, {
      cellDates: true,
      dense: true
    });
  } catch (_error) {
    throw new Error("I couldn’t read that spreadsheet. Please try another Excel file.");
  }

  const sections = [`Workbook: ${file.originalname}`];

  for (const sheetName of workbook.SheetNames || []) {
    const sheet = workbook.Sheets?.[sheetName];

    if (!sheet) {
      continue;
    }

    const csv = XLSX.utils.sheet_to_csv(sheet, {
      blankrows: false,
      strip: true
    }).trim();

    if (!csv) {
      continue;
    }

    sections.push(`Sheet: ${sheetName}\n${csv}`);
  }

  if (sections.length === 1) {
    throw new Error("That spreadsheet looks empty, so there wasn’t any text to analyze.");
  }

  const convertedPath = path.join(
    os.tmpdir(),
    `chatboteneto-sheet-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.txt`
  );

  await fs.writeFile(convertedPath, sections.join("\n\n"), "utf8");

  return {
    path: convertedPath,
    mimeType: "text/plain"
  };
}

function buildMediaAttachmentParts(attachments) {
  return attachments
    .filter(
      (attachment) =>
        (attachment?.strategy === "media" || attachment?.strategy === "longcontext") &&
        attachment?.uri &&
        attachment?.mimeType
    )
    .map((attachment) =>
      createPartFromUri(attachment.uri, attachment.mimeType)
    );
}

function extractDocumentSources(groundingMetadata) {
  const groundingChunks = groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const sources = [];

  for (const chunk of groundingChunks) {
    const retrievedContext = chunk?.retrievedContext;

    if (!retrievedContext) {
      continue;
    }

    const title = String(
      retrievedContext.title ||
        retrievedContext.uri ||
        "Retrieved document"
    ).trim();
    const url = String(retrievedContext.uri || "").trim();
    const rawSnippet = String(retrievedContext.text || "")
      .replace(/\s+/g, " ")
      .trim();
    const snippet =
      rawSnippet.length > 300
        ? `${rawSnippet.slice(0, 300).trim()}...`
        : rawSnippet;
    const key = `${title}::${url}`;

    if (!title || seen.has(key)) {
      continue;
    }

    seen.add(key);
    sources.push({
      title,
      url,
      snippet,
      cta: url ? "Open document" : "Grounded citation"
    });
  }

  return sources;
}

async function waitForMediaFileReady(fileName) {
  // Ramp intervals so small files respond in < 2s; cap total wait at ~30s
  // to stay safely within Vercel's 60s function timeout.
  const intervals = [500, 500, 1000, 1000, 1500, 1500, 2000];

  let currentFile = await genAI.files.get({ name: fileName });

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!currentFile?.state || currentFile.state === FileState.ACTIVE) {
      return currentFile;
    }

    if (currentFile.state === FileState.FAILED) {
      throw new Error(currentFile.error?.message || "File processing failed");
    }

    const delay = attempt < intervals.length ? intervals[attempt] : 2000;
    await sleep(delay);
    currentFile = await genAI.files.get({ name: fileName });
  }

  if (!currentFile?.state || currentFile.state === FileState.ACTIVE) {
    return currentFile;
  }

  if (currentFile.state === FileState.FAILED) {
    throw new Error(currentFile.error?.message || "File processing failed");
  }

  throw new Error(
    "The uploaded file is still processing. Please try again in a moment."
  );
}

async function deleteGeminiFile(fileName) {
  if (!fileName) {
    return true;
  }

  try {
    await genAI.files.delete({ name: fileName });
    return true;
  } catch (error) {
    console.error("[deleteGeminiFile]", error.message || error);
    return false;
  }
}

async function deleteFileSearchDocument(documentName) {
  if (!documentName) {
    return true;
  }

  try {
    await genAI.fileSearchStores.documents.delete({
      name: documentName,
      config: { force: true }
    });
    return true;
  } catch (error) {
    console.error("[deleteFileSearchDocument]", error.message || error);
    return false;
  }
}

async function deleteFileSearchStore(storeName) {
  if (!storeName) {
    return true;
  }

  try {
    await genAI.fileSearchStores.delete({
      name: storeName,
      config: { force: true }
    });
    return true;
  } catch (error) {
    console.error("[deleteFileSearchStore]", error.message || error);
    return false;
  }
}

async function waitForFileSearchOperationDone(operation) {
  let currentOperation = operation;
  const intervals = [500, 500, 750, 1000, 1000, 1500, 1500, 2000];

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (currentOperation?.done) {
      if (currentOperation.error) {
        throw new Error(
          currentOperation.error.message || "Document processing failed"
        );
      }

      return currentOperation;
    }

    const delay = attempt < intervals.length ? intervals[attempt] : 2000;
    await sleep(delay);
    currentOperation = await genAI.operations.get({
      operation: currentOperation
    });
  }

  if (currentOperation?.done) {
    if (currentOperation.error) {
      throw new Error(
        currentOperation.error.message || "Document processing failed"
      );
    }

    return currentOperation;
  }

  throw new Error("The uploaded document is still indexing. Please try again in a moment.");
}

async function ensureSessionFileSearchStore(session, sessionId) {
  if (session.fileSearchStoreName) {
    return session.fileSearchStoreName;
  }

  const store = await genAI.fileSearchStores.create({
    config: {
      displayName: `chatboteneto-${sessionId.slice(0, 8)}`
    }
  });

  if (!store?.name) {
    throw new Error("Could not create a file search store");
  }

  session.fileSearchStoreName = store.name;
  await saveSession(sessionId, session);
  return store.name;
}

async function importDocumentIntoSessionStore({
  session,
  sessionId,
  documentId,
  file,
  uploadedFile,
  mimeType
}) {
  const fileSearchStoreName = await ensureSessionFileSearchStore(session, sessionId);
  let operation = await genAI.fileSearchStores.importFile({
    fileSearchStoreName,
    fileName: uploadedFile.name,
    config: {}
  });

  operation = await waitForFileSearchOperationDone(operation);
  const documentResourceName = toDocumentResourceName(
    fileSearchStoreName,
    operation.response?.documentName
  );

  if (!documentResourceName) {
    throw new Error("Document indexing completed without a document name");
  }

  const document = await genAI.fileSearchStores.documents
    .get({
      name: documentResourceName
    })
    .catch(() => null);

  const attachment = {
    id: documentId,
    name: String(document?.name || documentResourceName || "").trim(),
    displayName: file.originalname,
    mimeType: String(document?.mimeType || mimeType || "").trim(),
    sizeBytes: Number(document?.sizeBytes || uploadedFile.sizeBytes || file.size || 0),
    state: String(document?.state || "").trim(),
    strategy: "document"
  };

  await firestoreLib.saveDocument(documentId, {
    filename: file.originalname,
    displayTitle: file.originalname,
    sourceType: "user_upload",
    language: "en",
    ingestionStatus: "done",
    scope: "session",
    isScan: false,
    geminiFileName: String(uploadedFile.name || "").trim(),
    fileSearchStoreName,
    geminiDocumentName: attachment.name
  });

  return attachment;
}

async function processDocumentInBackground({
  jobId,
  documentId,
  sessionId,
  geminiFileName,
  originalName,
  mimeType,
  sizeBytes
}) {
  try {
    await firestoreLib.updateIngestionJob(jobId, {
      status: "processing",
      errorMessage: null
    });

    const readyFile = await waitForMediaFileReady(geminiFileName);
    const storedSession = await firestoreLib.getSession(sessionId);

    if (!storedSession) {
      throw new Error("Session no longer exists.");
    }

    const session = normalizeSession(storedSession);
    await pruneExpiredMediaAttachments(sessionId, session);

    const attachment = await importDocumentIntoSessionStore({
      session,
      sessionId,
      documentId,
      file: {
        originalname: originalName,
        size: sizeBytes
      },
      uploadedFile: readyFile,
      mimeType
    });

    session.attachments = session.attachments
      .filter((item) => item.id !== documentId)
      .concat(attachment);
    await Promise.all([
      saveSession(sessionId, session),
      firestoreLib.updateIngestionJob(jobId, {
        status: "done",
        errorMessage: null
      })
    ]);
  } catch (error) {
    console.error("[processDocumentInBackground]", error.message || error);
    await Promise.allSettled([
      firestoreLib.updateIngestionJob(jobId, {
        status: "failed",
        errorMessage: error.message || String(error)
      }),
      firestoreLib.saveDocument(documentId, {
        filename: originalName,
        displayTitle: originalName,
        sourceType: "user_upload",
        language: "en",
        ingestionStatus: "failed",
        scope: "session",
        isScan: false,
        geminiFileName
      }),
      deleteGeminiFile(geminiFileName)
    ]);
  }
}


function isAttachmentExpired(attachment, now = Date.now()) {
  if (
    (attachment?.strategy !== "media" && attachment?.strategy !== "longcontext") ||
    !attachment?.expirationTime
  ) {
    return false;
  }

  const expiresAt = Date.parse(attachment.expirationTime);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

async function pruneExpiredMediaAttachments(sessionId, session) {
  if (!session?.attachments?.length) {
    return;
  }

  const now = Date.now();
  const expiredMedia = session.attachments.filter((attachment) =>
    isAttachmentExpired(attachment, now)
  );

  if (!expiredMedia.length) {
    return;
  }

  session.attachments = session.attachments.filter(
    (attachment) => !isAttachmentExpired(attachment, now)
  );

  await Promise.allSettled(
    expiredMedia.map((attachment) => deleteGeminiFile(attachment.name))
  );

  if (sessionId) {
    await saveSession(sessionId, session);
  }
}

async function runTavilySearch(query, options = {}) {
  if (!tavilyApiKey) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    config.SEARCH_TIMEOUT_MS
  );

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${tavilyApiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        query,
        topic: options.topic || "general",
        search_depth: "basic",
        max_results: config.MAX_SEARCH_RESULTS,
        include_answer: "basic",
        ...(options.timeRange
          ? { time_range: options.timeRange }
          : {}),
        ...(options.includeDomains?.length
          ? { include_domains: options.includeDomains }
          : {})
      })
    });

    if (!response.ok) {
      throw new Error(`Tavily returned ${response.status}`);
    }

    const data = await response.json();
    const parts = [];
    const rawSources = Array.isArray(data.results)
      ? data.results.slice(0, config.MAX_SEARCH_RESULTS).map((result, index) => {
          const title = String(result.title || `Source ${index + 1}`).trim();
          const url = String(result.url || "").trim();
          const rawContent = String(
            result.content || result.snippet || result.raw_content || ""
          )
            .replace(/\s+/g, " ")
            .trim();
          const snippet =
            rawContent.length > 300
              ? `${rawContent.slice(0, 300).trim()}...`
              : rawContent;

          return {
            title,
            url,
            snippet,
            cta: url ? "Open source" : "Source unavailable"
          };
        })
      : [];
    const sources = rerankItems(
      query,
      rawSources,
      (source) => `${source.title} ${source.url} ${source.snippet}`,
      (source) =>
        OFFICIAL_REFERENCE_DOMAINS.some((domain) =>
          String(source.url || "").includes(domain)
        )
          ? 2
          : 0
    );

    if (data.answer) {
      parts.push(`Answer:\n${String(data.answer).trim()}`);
    }

    if (sources.length) {
      const formattedResults = sources.map(
        (source, index) =>
          `Source ${index + 1}: ${source.title}\nURL: ${source.url || "Unavailable"}\nSummary: ${source.snippet || "No summary available."}`
      );
      parts.push(`Sources:\n${formattedResults.join("\n\n")}`);
    }

    if (!parts.length && !sources.length) {
      return null;
    }

    return {
      context: parts.length ? parts.join("\n\n") : null,
      sources
    };
  } catch (error) {
    console.error("[searchWeb]", error.name || error.message || error);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function searchWeb(query, options = {}) {
  const primaryResult = await runTavilySearch(query, options);

  if (primaryResult) {
    return primaryResult;
  }

  const shouldRetryGeneral = options.topic === "news";

  if (!shouldRetryGeneral) {
    return null;
  }

  return runTavilySearch(query, {
    ...options,
    topic: "general",
    timeRange: null
  });
}

async function summarizeTurns(turns) {
  try {
    const prompt = buildSummaryPrompt(turns);
    const response = await genAI.models.generateContent({
      model: config.GEMINI_MODEL,
      contents: prompt
    });
    const text = (response.text || "").trim();
    return text || null;
  } catch (error) {
    console.error("[summarizeTurns]", error.message || error);
    return null;
  }
}

function extractDocumentDate(value) {
  const text = String(value || "");
  const fullDateMatch = text.match(/\b(20\d{2})[._-]?(\d{2})[._-]?(\d{2})\b/);

  if (fullDateMatch) {
    return `${fullDateMatch[1]}-${fullDateMatch[2]}-${fullDateMatch[3]}`;
  }

  const monthYearMatch = text.match(/\b(\d{2})[./-](20\d{2})\b/);

  if (monthYearMatch) {
    return `${monthYearMatch[2]}-${monthYearMatch[1]}`;
  }

  return "";
}

async function buildRagContext(session, message, globalDocs) {
  const parts = [];

  if (globalDocs && globalDocs.length) {
    const rankedGlobalDocs = rerankItems(
      message,
      globalDocs,
      (doc) =>
        `${doc.displayTitle || ""} ${doc.filename || ""} ${doc.sourceType || ""} ${doc.productFamily || ""}`
    ).slice(0, config.MAX_RAG_CONTEXT_DOCUMENTS);
    const lines = rankedGlobalDocs.map((doc, i) => {
      const date = extractDocumentDate(doc.filename || doc.displayTitle || "");
      const sourceType = doc.sourceType ? ` | Type: ${doc.sourceType}` : "";
      return `  ${i + 1}. ${doc.displayTitle}${sourceType}${date ? ` | Date: ${date}` : ""}`;
    });
    parts.push(`Global knowledge base:\n${lines.join("\n")}`);
  }

  const documentAttachments = session.attachments.filter(
    (attachment) => attachment.strategy === "document"
  );

  if (documentAttachments.length) {
    const attachmentDocs = await Promise.all(
      documentAttachments.map(async (attachment, index) => {
        const doc = await firestoreLib.getDocument(attachment.id);
        const title =
          doc?.displayTitle ||
          attachment.displayName ||
          `Document ${index + 1}`;
        const date = extractDocumentDate(
          doc?.filename || attachment.displayName || title
        );
        return {
          title,
          filename: doc?.filename || attachment.displayName || title,
          sourceType: doc?.sourceType || "",
          line: `  ${index + 1}. ${title}${doc?.sourceType ? ` | Type: ${doc.sourceType}` : ""}${date ? ` | Date: ${date}` : ""}`
        };
      })
    );
    const rankedAttachmentDocs = rerankItems(
      message,
      attachmentDocs,
      (doc) => `${doc.title} ${doc.filename} ${doc.sourceType}`
    );
    const lines = rankedAttachmentDocs.map((doc) => doc.line);
    parts.push(`Your uploaded documents:\n${lines.join("\n")}`);
  }

  if (!parts.length) {
    return null;
  }

  return `Indexed documents for this chat:\n${parts.join("\n\n")}`;
}

function buildBegContext(records) {
  if (!records.length) {
    return null;
  }

  const lines = records.slice(0, config.MAX_BEG_CONTEXT_RECORDS).map((record, index) => {
    const details = [
      record.heatPumpType,
      record.refrigerant ? `Refrigerant: ${record.refrigerant}` : "",
      Number.isFinite(record.etas35)
        ? `ETAs 35: ${record.etas35}%`
        : "",
      Number.isFinite(record.etas55)
        ? `ETAs 55: ${record.etas55}%`
        : "",
      `Page ${record.pageNumber}`
    ].filter(Boolean);

    return `${index + 1}. ${record.manufacturer} | ${record.modelName}\n   ${details.join(" | ")}`;
  });

  return lines.join("\n");
}

function buildBegSourceItems(records) {
  return records.slice(0, config.MAX_BEG_CONTEXT_RECORDS).map((record) => {
    const snippetParts = [
      record.heatPumpType,
      record.refrigerant ? `Refrigerant ${record.refrigerant}` : "",
      Number.isFinite(record.etas35) ? `ETAs 35 ${record.etas35}%` : "",
      Number.isFinite(record.etas55) ? `ETAs 55 ${record.etas55}%` : "",
      `Page ${record.pageNumber}`
    ].filter(Boolean);

    return {
      title: `${record.manufacturer} ${record.modelName}`.trim(),
      url: "",
      snippet: snippetParts.join(" | "),
      cta: "Structured record"
    };
  });
}

async function searchBegRecords(message, knowledgeConfig) {
  if (!knowledgeConfig?.begRecordCount || !knowledgeConfig?.begManufacturers?.length) {
    return null;
  }

  const manufacturerMatch = findManufacturerMatch(
    message,
    knowledgeConfig.begManufacturers
  );
  const heatPumpType = detectHeatPumpType(message);
  const modelQuery = extractModelQuery(message, manufacturerMatch, heatPumpType);
  const hasSpecificModelQuery =
    /[0-9]/.test(modelQuery) || modelQuery.split(" ").filter(Boolean).length >= 2;

  if (
    (!manufacturerMatch && !hasSpecificModelQuery) ||
    (manufacturerMatch && !hasSpecificModelQuery && !heatPumpType)
  ) {
    return null;
  }

  const candidateRecords = await firestoreLib.queryBegRecords({
    manufacturerNormalized: manufacturerMatch?.manufacturerNormalized || "",
    heatPumpType,
    begEligible: true
  });

  if (!candidateRecords.length) {
    return null;
  }

  const rankedRecords = rerankItems(
    `${manufacturerMatch?.displayName || ""} ${modelQuery} ${heatPumpType}`.trim(),
    candidateRecords,
    (record) =>
      `${record.manufacturer} ${record.modelName} ${record.heatPumpType} ${record.refrigerant || ""}`,
    (record) => (record.begEligible ? 2 : 0)
  ).slice(0, config.MAX_BEG_CONTEXT_RECORDS);

  if (!rankedRecords.length) {
    return null;
  }

  return {
    context: buildBegContext(rankedRecords),
    sources: buildBegSourceItems(rankedRecords)
  };
}

app.get("/api/attachments", async (req, res) => {
  const sessionId =
    typeof req.query?.sessionId === "string" ? req.query.sessionId.trim() : "";
  const forceRefresh = String(req.query?.refresh || "") === "1";

  if (!sessionId) {
    return res.json({ attachments: [] });
  }

  const session = await getSession(sessionId, { forceRefresh });
  await pruneExpiredMediaAttachments(sessionId, session);
  return res.json({ attachments: session?.attachments || [] });
});

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, async (error) => {
    const tempFilePath = req.file?.path;
    let convertedFilePath = "";
    let uploadedGeminiFileName = "";
    let documentQueued = false;

    try {
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({
            error: `file exceeds ${Math.round(
              config.MAX_UPLOAD_BYTES / (1024 * 1024)
            )} MB`
          });
        }

        return res.status(400).json({ error: error.message });
      }

      if (error) {
        throw error;
      }

      const sessionId =
        typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";

      if (!sessionId || !req.file) {
        return res
          .status(400)
          .json({ error: "sessionId and file are required" });
      }

      if (isUploadRateLimited(getUploadRateLimitKey(req, sessionId))) {
        return res.status(429).json({ error: "upload rate limit exceeded" });
      }

      const session = await getSession(sessionId);
      await pruneExpiredMediaAttachments(sessionId, session);

      if (session.attachments.length >= config.MAX_SESSION_FILES) {
        return res.status(400).json({
          error: `You can attach up to ${config.MAX_SESSION_FILES} files per chat`
        });
      }

      const uploadDescriptor = resolveUploadDescriptor(req.file);
      let uploadMimeType = uploadDescriptor?.mimeType || "";
      let uploadFilePath = req.file.path;

      if (!uploadDescriptor) {
        return res.status(400).json({
          error:
            "Unsupported file type. Use PDF, TXT, MD, CSV, JSON, DOCX, XLSX, PPTX, HTML, XML, ZIP, or common image files."
        });
      }

      if (isSpreadsheetMimeType(uploadDescriptor.mimeType)) {
        const convertedFile = await convertSpreadsheetToTextFile(
          req.file
        );
        convertedFilePath = convertedFile.path;
        uploadFilePath = convertedFile.path;
        uploadMimeType = convertedFile.mimeType;
      }

      const uploadedFile = await genAI.files.upload({
        file: uploadFilePath,
        config: {
          displayName: req.file.originalname,
          mimeType: uploadMimeType
        }
      });
      uploadedGeminiFileName = uploadedFile.name || "";
      let attachment;

      if (
        uploadDescriptor.strategy === "document" &&
        !supportsInlineLongContextMimeType(uploadMimeType)
      ) {
        const jobId = randomUUID();
        const documentId = randomUUID();
        documentQueued = true;

        await Promise.all([
          firestoreLib.createIngestionJob(jobId, documentId, sessionId),
          firestoreLib.saveDocument(documentId, {
            filename: req.file.originalname,
            displayTitle: req.file.originalname,
            sourceType: "user_upload",
            language: "en",
            ingestionStatus: "pending",
            scope: "session",
            isScan: false,
            geminiFileName: uploadedGeminiFileName
          })
        ]);

        void processDocumentInBackground({
          jobId,
          documentId,
          sessionId,
          geminiFileName: uploadedGeminiFileName,
          originalName: req.file.originalname,
          mimeType: uploadMimeType,
          sizeBytes: req.file.size
        });

        return res.json({
          ok: true,
          jobId,
          documentId
        });
      } else {
        const readyFile = await waitForMediaFileReady(uploadedFile.name);

        if (uploadDescriptor.strategy === "document") {
          attachment = {
            id: String(readyFile.name || "").replace(/^files\//, ""),
            name: String(readyFile.name || "").trim(),
            displayName: req.file.originalname,
            mimeType: uploadMimeType,
            sizeBytes: Number(readyFile.sizeBytes || req.file.size || 0),
            expirationTime: String(readyFile.expirationTime || "").trim(),
            uri: String(readyFile.uri || "").trim(),
            strategy: "longcontext"
          };
        } else if (uploadDescriptor.strategy === "media") {
          attachment = serializeMediaFile(readyFile, req.file.originalname);
        }
      }

      if (
        uploadDescriptor.strategy === "document" &&
        supportsInlineLongContextMimeType(uploadMimeType)
      ) {
        attachment = {
          ...attachment,
          strategy: "longcontext"
        };
      }

      session.attachments.push(attachment);
      await saveSession(sessionId, session);

      return res.json({
        ok: true,
        attachments: session.attachments,
        file: attachment
      });
    } catch (uploadError) {
      if (uploadedGeminiFileName && !documentQueued) {
        await deleteGeminiFile(uploadedGeminiFileName);
      }

      console.error("[/api/upload]", uploadError.message || uploadError);
      return res.status(500).json({
        error:
          "I couldn’t upload that file just now. Please try again with a supported file."
      });
    } finally {
      if (convertedFilePath) {
        await fs.unlink(convertedFilePath).catch(() => {});
      }

      if (tempFilePath) {
        await fs.unlink(tempFilePath).catch(() => {});
      }
    }
  });
});

app.get("/api/ingest/status/:jobId", async (req, res) => {
  const job = await firestoreLib.getIngestionJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.json({
    status: job.status,
    documentId: job.documentId,
    errorMessage: job.errorMessage || null
  });
});

app.delete("/api/attachments/:attachmentId", async (req, res) => {
  const sessionId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  const attachmentId =
    typeof req.params?.attachmentId === "string"
      ? req.params.attachmentId.trim()
      : "";

  if (!sessionId || !attachmentId) {
    return res
      .status(400)
      .json({ error: "sessionId and attachmentId are required" });
  }

  const cachedSession = sessionCache.get(sessionId);
  const storedSession = cachedSession || await firestoreLib.getSession(sessionId);
  const session = cachedSession ||
    (storedSession ? normalizeSession(storedSession) : null);

  if (!session) {
    return res.json({ ok: true, attachments: [] });
  }

  sessionCache.set(sessionId, session);
  sessionCacheTouchedAt.set(sessionId, Date.now());
  await pruneExpiredMediaAttachments(sessionId, session);

  const attachmentIndex = session.attachments.findIndex(
    (attachment) => attachment.id === attachmentId
  );

  if (attachmentIndex === -1) {
    return res.json({ ok: true, attachments: session.attachments });
  }

  const attachment = session.attachments[attachmentIndex];

  try {
    if (attachment.strategy === "document") {
      const documentMeta = await firestoreLib.getDocument(attachment.id).catch(() => null);
      const cleanupResults = await Promise.all([
        deleteFileSearchDocument(attachment.name),
        documentMeta?.geminiFileName
          ? deleteGeminiFile(documentMeta.geminiFileName)
          : Promise.resolve(true),
        documentMeta?.transcriptionFileName
          ? deleteGeminiFile(documentMeta.transcriptionFileName)
          : Promise.resolve(true)
      ]);

      if (cleanupResults.some((result) => result === false)) {
        throw new Error("Could not delete the indexed document");
      }
    } else {
      const deleted = await deleteGeminiFile(attachment.name);

      if (!deleted) {
        throw new Error("Could not delete the uploaded file");
      }
    }
  } catch (deleteError) {
    console.error("[deleteAttachment]", deleteError.message || deleteError);
    return res
      .status(502)
      .json({ error: "Could not remove that file just now. Please try again." });
  }

  session.attachments.splice(attachmentIndex, 1);
  if (
    attachment.strategy === "document" &&
    !session.attachments.some((item) => item.strategy === "document")
  ) {
    const deletedStore = await deleteFileSearchStore(session.fileSearchStoreName);

    if (deletedStore) {
      session.fileSearchStoreName = null;
    }
  }
  await saveSession(sessionId, session);

  return res.json({ ok: true, attachments: session.attachments });
});

app.post("/api/chat", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const sessionId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  const forceWebSearch = req.body?.forceWebSearch === true;

  if (!message || !sessionId) {
    return res.status(400).json({ error: "message and sessionId are required" });
  }

  if (message.length > config.MAX_INPUT_CHARS) {
    return res.status(400).json({
      error: `message exceeds ${config.MAX_INPUT_CHARS} characters`
    });
  }

  if (isRateLimited(sessionId)) {
    return res.status(429).json({ error: "rate limit exceeded" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  let clientClosed = false;

  const send = (data) => {
    if (!clientClosed && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  res.on("close", () => {
    clientClosed = true;
  });

  try {
    const session = await getSession(sessionId);
    await pruneExpiredMediaAttachments(sessionId, session);

    if (session.turns.length >= config.MAX_HISTORY_TURNS) {
      const splitIndex = Math.max(
        session.turns.length - config.SUMMARY_KEEP_TURNS,
        0
      );
      const toSummarize = session.turns.slice(0, splitIndex);
      const toKeep = session.turns.slice(splitIndex);

      if (toSummarize.length) {
        send({ type: "status", content: "summarizing" });
        const newSummary = await summarizeTurns(toSummarize);

        if (newSummary) {
          session.summary = session.summary
            ? `${session.summary}\n${newSummary}`
            : newSummary;
          session.turns = toKeep;
          await saveSession(sessionId, session);
        }
      }
    }

    const sessionHasInlineDocuments = session.attachments.some(
      (attachment) => attachment.strategy === "longcontext"
    );
    const sessionHasIndexedDocuments =
      !!session.fileSearchStoreName &&
      session.attachments.some((attachment) => attachment.strategy === "document");
    const useOnlyUserDocuments =
      (sessionHasInlineDocuments || sessionHasIndexedDocuments) &&
      isFileFocusedQuestion(message);
    const knowledgeConfig = await getGlobalStoreConfig();
    const candidateStoreNames = [...new Set(
      [
        sessionHasIndexedDocuments ? session.fileSearchStoreName : null,
        useOnlyUserDocuments ? null : knowledgeConfig.storeName
      ].filter(Boolean)
    )];
    const retrievalPlan = classifyRetrieval(message, {
      forceWebSearch,
      hasDocumentStores: candidateStoreNames.length > 0,
      hasUserDocuments: sessionHasIndexedDocuments,
      hasBegRecords: knowledgeConfig.begRecordCount > 0
    });
    const shouldSearch = retrievalPlan.wantsWeb;
    const webSearchRequest = shouldSearch
      ? buildWebSearchRequest(message, [
          ...config.OFFICIAL_WEB_DOMAINS,
          ...OFFICIAL_REFERENCE_DOMAINS
        ])
      : null;
    const hasIndexedDocuments =
      retrievalPlan.wantsDocuments && candidateStoreNames.length > 0;
    if (shouldSearch) {
      send({ type: "status", content: "searching" });
    }

    const [webContext, ragContext, begLookup] = await Promise.all([
      webSearchRequest
        ? searchWeb(webSearchRequest.query, {
            topic: webSearchRequest.topic,
            timeRange:
              webSearchRequest.topic === "news"
                ? config.SEARCH_NEWS_TIME_RANGE
                : null,
            includeDomains: webSearchRequest.includeDomains
          })
        : Promise.resolve(null),
      hasIndexedDocuments
        ? buildRagContext(
            session,
            message,
            useOnlyUserDocuments ? [] : knowledgeConfig.documents
          )
        : Promise.resolve(null),
      retrievalPlan.wantsBegRecords
        ? searchBegRecords(message, knowledgeConfig)
        : Promise.resolve(null)
    ]);
    const fileSearchStoreNames = hasIndexedDocuments ? candidateStoreNames : [];
    const normalizedWebContext = webContext?.context || null;
    const webSources = webContext?.sources || [];
    const begContext = begLookup?.context || null;
    const begSources = begLookup?.sources || [];
    const mediaParts = buildMediaAttachmentParts(session.attachments);

    if (shouldSearch && (normalizedWebContext || webSources.length)) {
      send({ type: "status", content: "searched" });
    }

    const prompt = buildPrompt({
      history: session.turns,
      summary: session.summary,
      webContext: normalizedWebContext,
      ragContext,
      begContext,
      userMessage: message,
      mode: retrievalPlan.mode
    });

    if (clientClosed) {
      return;
    }

    send({
      type: "status",
      content:
        hasIndexedDocuments || begContext ? "retrieving" : "responding"
    });

    const responseStream = await genAI.models.generateContentStream({
      model: hasIndexedDocuments
        ? config.GEMINI_FILE_SEARCH_MODEL
        : config.GEMINI_MODEL,
      contents: [createUserContent([prompt, ...mediaParts])],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        ...(hasIndexedDocuments
          ? {
              tools: [
                {
                  fileSearch: {
                    fileSearchStoreNames,
                    topK: config.FILE_SEARCH_TOP_K
                  }
                }
              ]
            }
          : {})
      }
    });
    let fullResponse = "";
    let lastGroundingMetadata = null;

    for await (const chunk of responseStream) {
      if (clientClosed) {
        return;
      }

      if (chunk?.candidates?.[0]?.groundingMetadata) {
        lastGroundingMetadata = chunk.candidates[0].groundingMetadata;
      }

      const chunkText = chunk.text || "";

      if (!chunkText) {
        continue;
      }

      fullResponse += chunkText;
      send({ type: "text", content: chunkText });
    }

    if (clientClosed) {
      return;
    }

    session.turns.push({ role: "user", content: message });
    session.turns.push({ role: "assistant", content: fullResponse.trim() });
    await saveSession(sessionId, session);

    const documentSources = extractDocumentSources(lastGroundingMetadata);

    if (documentSources.length) {
      send({
        type: "sources",
        content: {
          label: "Document sources",
          items: documentSources
        }
      });
    }

    if (begSources.length) {
      send({
        type: "sources",
        content: {
          label: "BEG structured records",
          items: begSources
        }
      });
    }

    if (webSources.length) {
      send({
        type: "sources",
        content: {
          label: "Web sources",
          items: webSources
        }
      });
    }

    send({ type: "done" });
    res.end();
  } catch (error) {
    console.error("[/api/chat]", error.message || error);
    send({ type: "error", content: config.FALLBACK_MESSAGE });
    res.end();
  }
});

app.post("/api/reset", async (req, res) => {
  const sessionId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";

    if (sessionId) {
      const cachedSession = sessionCache.get(sessionId);
      const storedSession = cachedSession || await firestoreLib.getSession(sessionId);
    const session = cachedSession ||
      (storedSession ? normalizeSession(storedSession) : null);

      if (session?.attachments?.length) {
        const documentCleanupTargets = await Promise.all(
          session.attachments
            .filter((a) => a.strategy === "document")
            .map(async (a) => ({
              attachment: a,
              documentMeta: await firestoreLib.getDocument(a.id).catch(() => null)
            }))
        );

        await Promise.allSettled([
          ...session.attachments
            .filter((a) => a.strategy === "media" || a.strategy === "longcontext")
            .map((a) => deleteGeminiFile(a.name)),
          ...documentCleanupTargets.flatMap(({ attachment, documentMeta }) => [
            deleteFileSearchDocument(attachment.name),
            documentMeta?.geminiFileName
              ? deleteGeminiFile(documentMeta.geminiFileName)
              : Promise.resolve(true),
            documentMeta?.transcriptionFileName
              ? deleteGeminiFile(documentMeta.transcriptionFileName)
              : Promise.resolve(true)
          ]),
          session.fileSearchStoreName
            ? deleteFileSearchStore(session.fileSearchStoreName)
            : Promise.resolve(true)
        ]);
      }

    sessionCache.delete(sessionId);
    sessionCacheTouchedAt.delete(sessionId);
    await firestoreLib.deleteSession(sessionId);
    rateLimitBuckets.delete(sessionId);
    uploadRateLimitBuckets.delete(sessionId);
  }

  res.json({ ok: true });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    sessions: sessionCache.size,
    model: config.GEMINI_MODEL,
    fileSearchModel: config.GEMINI_FILE_SEARCH_MODEL
  });
});

const PORT = Number(process.env.PORT) || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Chatbot server listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
