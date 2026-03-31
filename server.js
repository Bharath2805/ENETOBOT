require("dotenv").config();

const express = require("express");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const cors = require("cors");
const multer = require("multer");
const {
  DocumentState,
  FileState,
  GoogleGenAI,
  createPartFromUri,
  createUserContent
} = require("@google/genai");

const config = require("./config");
const {
  SYSTEM_PROMPT,
  needsWebSearch,
  buildPrompt,
  buildSummaryPrompt
} = require("./prompt");

const app = express();
const publicDir = path.join(__dirname, "public");
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
const sessions = new Map();
const rateLimits = new Map();
const uploadRateLimits = new Map();
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

app.use(cors());
app.use(express.json());
app.use(express.static(publicDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      attachments: [],
      fileSearchStoreName: null,
      turns: [],
      summary: null
    });
  }

  return sessions.get(sessionId);
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
  return isOverLimit(rateLimits, sessionId, config.RATE_LIMIT_RPM);
}

function isUploadRateLimited(sessionId) {
  return isOverLimit(
    uploadRateLimits,
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

function serializeDocument(document) {
  const name = String(document?.name || "").trim();

  return {
    id: name.split("/").pop() || "",
    name,
    displayName: String(document?.displayName || "Uploaded document"),
    mimeType: String(document?.mimeType || "").trim(),
    sizeBytes: Number(document?.sizeBytes || 0),
    state: String(document?.state || "").trim(),
    strategy: "document"
  };
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

function buildMediaAttachmentParts(attachments) {
  return attachments
    .filter(
      (attachment) =>
        attachment?.strategy === "media" &&
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

async function ensureFileSearchStore(session, sessionId) {
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
  return store.name;
}

async function waitForOperationDone(operation) {
  let currentOperation = operation;

  for (
    let attempt = 0;
    attempt < config.UPLOAD_POLL_ATTEMPTS;
    attempt += 1
  ) {
    if (currentOperation?.done) {
      if (currentOperation.error) {
        throw new Error(
          currentOperation.error.message || "Document processing failed"
        );
      }

      return currentOperation;
    }

    await sleep(config.UPLOAD_POLL_INTERVAL_MS);
    currentOperation = await genAI.operations.get({
      operation: currentOperation
    });
  }

  // Check the result of the final poll before giving up.
  if (currentOperation?.done) {
    if (currentOperation.error) {
      throw new Error(
        currentOperation.error.message || "Document processing failed"
      );
    }

    return currentOperation;
  }

  throw new Error(
    "The uploaded document is still indexing. Please try again in a moment."
  );
}

async function waitForDocumentReady(documentName) {
  let document = await genAI.fileSearchStores.documents.get({
    name: documentName
  });

  for (
    let attempt = 0;
    attempt < config.UPLOAD_POLL_ATTEMPTS;
    attempt += 1
  ) {
    if (!document?.state || document.state === DocumentState.STATE_ACTIVE) {
      return document;
    }

    if (document.state === DocumentState.STATE_FAILED) {
      throw new Error("Document indexing failed");
    }

    await sleep(config.UPLOAD_POLL_INTERVAL_MS);
    document = await genAI.fileSearchStores.documents.get({
      name: documentName
    });
  }

  // Check the result of the final poll before giving up.
  if (!document?.state || document.state === DocumentState.STATE_ACTIVE) {
    return document;
  }

  if (document.state === DocumentState.STATE_FAILED) {
    throw new Error("Document indexing failed");
  }

  throw new Error(
    "The uploaded document is still indexing. Please try again in a moment."
  );
}

async function waitForMediaFileReady(fileName) {
  let currentFile = await genAI.files.get({ name: fileName });

  for (
    let attempt = 0;
    attempt < config.UPLOAD_POLL_ATTEMPTS;
    attempt += 1
  ) {
    if (!currentFile?.state || currentFile.state === FileState.ACTIVE) {
      return currentFile;
    }

    if (currentFile.state === FileState.FAILED) {
      throw new Error(currentFile.error?.message || "File processing failed");
    }

    await sleep(config.UPLOAD_POLL_INTERVAL_MS);
    currentFile = await genAI.files.get({ name: fileName });
  }

  // Check the result of the final poll before giving up.
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

function isAttachmentExpired(attachment, now = Date.now()) {
  if (attachment?.strategy !== "media" || !attachment?.expirationTime) {
    return false;
  }

  const expiresAt = Date.parse(attachment.expirationTime);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

async function pruneExpiredMediaAttachments(session) {
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
}

async function searchWeb(query) {
  if (!process.env.TAVILY_API_KEY) {
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
        "Authorization": `Bearer ${process.env.TAVILY_API_KEY}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: config.MAX_SEARCH_RESULTS,
        include_answer: true
      })
    });

    if (!response.ok) {
      throw new Error(`Tavily returned ${response.status}`);
    }

    const data = await response.json();
    const parts = [];
    const sources = Array.isArray(data.results)
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

app.get("/api/attachments", async (req, res) => {
  const sessionId =
    typeof req.query?.sessionId === "string" ? req.query.sessionId.trim() : "";

  if (!sessionId) {
    return res.json({ attachments: [] });
  }

  const session = sessions.get(sessionId);
  await pruneExpiredMediaAttachments(session);
  return res.json({ attachments: session?.attachments || [] });
});

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, async (error) => {
    const tempFilePath = req.file?.path;
    let uploadedMediaFileName = "";

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

      const session = getSession(sessionId);
      await pruneExpiredMediaAttachments(session);

      if (session.attachments.length >= config.MAX_SESSION_FILES) {
        return res.status(400).json({
          error: `You can attach up to ${config.MAX_SESSION_FILES} files per chat`
        });
      }

      const uploadDescriptor = resolveUploadDescriptor(req.file);

      if (!uploadDescriptor) {
        return res.status(400).json({
          error:
            "Unsupported file type. Use PDF, TXT, MD, CSV, JSON, DOCX, XLSX, PPTX, HTML, XML, ZIP, or common image files."
        });
      }

      let attachment;

      if (uploadDescriptor.strategy === "document") {
        const storeName = await ensureFileSearchStore(session, sessionId);
        let operation = await genAI.fileSearchStores.uploadToFileSearchStore({
          file: req.file.path,
          fileSearchStoreName: storeName,
          config: {
            displayName: req.file.originalname,
            mimeType: uploadDescriptor.mimeType
          }
        });

        operation = await waitForOperationDone(operation);

        const documentName = operation.response?.documentName;

        if (!documentName) {
          throw new Error("Document indexing completed without a document name");
        }

        const document = await waitForDocumentReady(documentName);
        attachment = serializeDocument(document);
      } else {
        const uploadedFile = await genAI.files.upload({
          file: req.file.path,
          config: {
            displayName: req.file.originalname,
            mimeType: uploadDescriptor.mimeType
          }
        });
        uploadedMediaFileName = uploadedFile.name || "";

        const readyFile = await waitForMediaFileReady(uploadedFile.name);
        attachment = serializeMediaFile(readyFile, req.file.originalname);
      }

      session.attachments.push(attachment);

      return res.json({
        ok: true,
        attachments: session.attachments,
        file: attachment
      });
    } catch (uploadError) {
      if (uploadedMediaFileName) {
        await deleteGeminiFile(uploadedMediaFileName);
      }

      console.error("[/api/upload]", uploadError.message || uploadError);
      return res.status(500).json({
        error:
          "I couldn’t upload that file just now. Please try again with a supported file."
      });
    } finally {
      if (tempFilePath) {
        await fs.unlink(tempFilePath).catch(() => {});
      }
    }
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

  const session = sessions.get(sessionId);

  if (!session) {
    return res.json({ ok: true, attachments: [] });
  }

  await pruneExpiredMediaAttachments(session);

  const attachmentIndex = session.attachments.findIndex(
    (attachment) => attachment.id === attachmentId
  );

  if (attachmentIndex === -1) {
    return res.json({ ok: true, attachments: session.attachments });
  }

  const attachment = session.attachments[attachmentIndex];

  try {
    if (attachment.strategy === "document") {
      await genAI.fileSearchStores.documents.delete({
        name: attachment.name,
        config: { force: true }
      });
    } else {
      const deleted = await deleteGeminiFile(attachment.name);

      if (!deleted) {
        throw new Error("Could not delete the uploaded media file");
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

  return res.json({ ok: true, attachments: session.attachments });
});

app.post("/api/chat", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const sessionId =
    typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";

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
    const session = getSession(sessionId);
    await pruneExpiredMediaAttachments(session);

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
        }
      }
    }

    const shouldSearch = needsWebSearch(message);

    if (shouldSearch) {
      send({ type: "status", content: "searching" });
    }

    const [webContext] = await Promise.all([
      shouldSearch ? searchWeb(message) : Promise.resolve(null)
      // Phase 2: ragSearch goes here
    ]);

    const normalizedWebContext = webContext?.context || null;
    const webSources = webContext?.sources || [];
    const hasIndexedDocuments =
      !!session.fileSearchStoreName &&
      session.attachments.some((attachment) => attachment.strategy === "document");
    const mediaParts = buildMediaAttachmentParts(session.attachments);

    if (shouldSearch && (normalizedWebContext || webSources.length)) {
      send({ type: "status", content: "searched" });
    }

    const prompt = buildPrompt({
      history: session.turns,
      summary: session.summary,
      webContext: normalizedWebContext,
      userMessage: message
    });

    if (clientClosed) {
      return;
    }

    send({
      type: "status",
      content: hasIndexedDocuments ? "retrieving" : "responding"
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
                    fileSearchStoreNames: [session.fileSearchStoreName],
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
    const session = sessions.get(sessionId);

    if (session?.attachments?.length) {
      await Promise.allSettled(
        session.attachments
          .filter((attachment) => attachment.strategy === "media")
          .map((attachment) => deleteGeminiFile(attachment.name))
      );
    }

    if (session?.fileSearchStoreName) {
      await deleteFileSearchStore(session.fileSearchStoreName);
    }

    sessions.delete(sessionId);
    rateLimits.delete(sessionId);
    uploadRateLimits.delete(sessionId);
  }

  res.json({ ok: true });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    sessions: sessions.size,
    model: config.GEMINI_MODEL,
    fileSearchModel: config.GEMINI_FILE_SEARCH_MODEL
  });
});

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`Chatbot server listening on http://localhost:${PORT}`);
});
