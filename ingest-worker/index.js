const express = require("express");
const dotenv = require("dotenv");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { Firestore } = require("@google-cloud/firestore");
const {
  DocumentState,
  FileState,
  GoogleGenAI,
  createPartFromUri,
  createUserContent
} = require("@google/genai");

dotenv.config();

let db;

function parseCredentials() {
  const rawCredentials = String(process.env.GOOGLE_CREDENTIALS_JSON || "").trim();

  if (!rawCredentials) {
    return undefined;
  }

  try {
    return JSON.parse(rawCredentials);
  } catch (_error) {
    return JSON.parse(Buffer.from(rawCredentials, "base64").toString("utf8"));
  }
}

function getDb() {
  if (!db) {
    const credentials = parseCredentials();
    db = new Firestore({
      projectId: process.env.GOOGLE_PROJECT_ID || credentials?.project_id,
      credentials
    });
  }

  return db;
}

function now() {
  return Firestore.Timestamp.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateIngestionError(error) {
  return String(error?.message || error || "Ingestion failed").slice(0, 500);
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

function buildChunkingConfig(metadata) {
  if (metadata.sourceType === "beg_list") {
    return {
      whiteSpaceConfig: {
        maxTokensPerChunk: 220,
        maxOverlapTokens: 40
      }
    };
  }

  if (metadata.sourceType === "faq") {
    return {
      whiteSpaceConfig: {
        maxTokensPerChunk: 260,
        maxOverlapTokens: 40
      }
    };
  }

  if (
    metadata.sourceType === "playbook" ||
    metadata.sourceType === "onboarding"
  ) {
    return {
      whiteSpaceConfig: {
        maxTokensPerChunk: 420,
        maxOverlapTokens: 80
      }
    };
  }

  return {
    whiteSpaceConfig: {
      maxTokensPerChunk: 360,
      maxOverlapTokens: 60
    }
  };
}

function buildCustomMetadata(metadata) {
  return [
    { key: "scope", stringValue: metadata.scope || "session" },
    { key: "sourceType", stringValue: metadata.sourceType || "product" },
    { key: "language", stringValue: metadata.language || "de" },
    metadata.productFamily
      ? { key: "productFamily", stringValue: metadata.productFamily }
      : null,
    metadata.sourceDate
      ? { key: "sourceDate", stringValue: metadata.sourceDate }
      : null,
    { key: "isScan", stringValue: metadata.isScan ? "true" : "false" }
  ].filter(Boolean);
}

async function transcribeScanDocument(file, metadata) {
  const transcriptionPrompt = [
    `Transcribe the attached scanned ${metadata.sourceType || "document"} PDF into clean markdown.`,
    "Preserve headings, bullet lists, tables, product names, numbers, and page references.",
    "If text spans multiple columns, reconstruct it in normal reading order.",
    "Return markdown only."
  ].join(" ");
  const response = await genAI.models.generateContent({
    model: process.env.OCR_MODEL || "gemini-2.5-flash",
    contents: [
      createUserContent([
        transcriptionPrompt,
        createPartFromUri(file.uri, file.mimeType)
      ])
    ]
  });
  return String(response.text || "").trim();
}

async function uploadTextDerivativeToFileSearchStore(
  markdown,
  displayName,
  fileSearchStoreName,
  metadata
) {
  const derivativePath = path.join(os.tmpdir(), `${randomUUID()}.md`);
  await fs.writeFile(derivativePath, markdown, "utf8");

  try {
    return genAI.fileSearchStores.uploadToFileSearchStore({
      fileSearchStoreName,
      file: derivativePath,
      config: {
        displayName,
        mimeType: "text/markdown",
        customMetadata: buildCustomMetadata(metadata),
        chunkingConfig: buildChunkingConfig(metadata)
      }
    });
  } finally {
    await fs.unlink(derivativePath).catch(() => {});
  }
}

async function uploadTextDerivative(markdown, displayName) {
  const derivativePath = path.join(os.tmpdir(), `${randomUUID()}.md`);
  await fs.writeFile(derivativePath, markdown, "utf8");

  try {
    const uploadedFile = await genAI.files.upload({
      file: derivativePath,
      config: {
        displayName,
        mimeType: "text/markdown"
      }
    });

    return waitForFileReady(uploadedFile.name || "");
  } finally {
    await fs.unlink(derivativePath).catch(() => {});
  }
}

function createDefaultSession() {
  return {
    turns: [],
    summary: null,
    fileSearchStoreName: null,
    attachments: []
  };
}

function normalizeSession(session) {
  return {
    turns: Array.isArray(session?.turns) ? session.turns : [],
    summary: session?.summary || null,
    fileSearchStoreName: session?.fileSearchStoreName || null,
    attachments: Array.isArray(session?.attachments) ? session.attachments : []
  };
}

async function getSession(sessionId) {
  const snapshot = await getDb().collection("sessions").doc(sessionId).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function saveSession(sessionId, session) {
  await getDb().collection("sessions").doc(sessionId).set(
    {
      turns: session.turns,
      summary: session.summary,
      fileSearchStoreName: session.fileSearchStoreName,
      attachments: session.attachments,
      updatedAt: now()
    },
    { merge: true }
  );
}

async function updateIngestionJob(jobId, fields) {
  await getDb().collection("ingestionJobs").doc(jobId).set(fields, {
    merge: true
  });
}

async function updateDocument(documentId, fields) {
  await getDb().collection("documents").doc(documentId).set(fields, {
    merge: true
  });
}

async function getDocument(documentId) {
  const snapshot = await getDb().collection("documents").doc(documentId).get();
  return snapshot.exists ? snapshot.data() : null;
}

const genAI = new GoogleGenAI({
  apiKey:
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_API ||
    ""
});
const FILE_SEARCH_OPERATION_POLL_ATTEMPTS = 300;

async function waitForFileReady(fileName) {
  // Poll with a short initial interval — files uploaded just before this call
  // are usually ACTIVE within 1-2 seconds for text PDFs.
  const intervals = [500, 500, 1000, 1000, 1500, 1500, 2000];

  let currentFile = await genAI.files.get({ name: fileName });

  for (let attempt = 0; attempt < 40; attempt += 1) {
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

  throw new Error("The uploaded file is still processing. Please try again in a moment.");
}

async function waitForOperationDone(operation) {
  let currentOperation = operation;
  const intervals = [500, 500, 750, 1000, 1000, 1500, 1500, 2000];

  for (
    let attempt = 0;
    attempt < FILE_SEARCH_OPERATION_POLL_ATTEMPTS;
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

async function importFileToStore(fileSearchStoreName, fileName, metadata) {
  let operation = await genAI.fileSearchStores.importFile({
    fileSearchStoreName,
    fileName,
    config: {
      customMetadata: buildCustomMetadata(metadata),
      chunkingConfig: buildChunkingConfig(metadata)
    }
  });

  return waitForOperationDone(operation);
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
  await saveSession(sessionId, session);
  return store.name;
}

const app = express();

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/process", async (req, res) => {
  const jobId = String(req.body?.jobId || "").trim();
  const documentId = String(req.body?.documentId || "").trim();
  const geminiFileName = String(req.body?.geminiFileName || "").trim();
  const sessionId = String(req.body?.sessionId || "").trim();

  try {
    await updateIngestionJob(jobId, {
      status: "processing",
      errorMessage: null
    });
    await updateDocument(documentId, {
      ingestionStatus: "processing",
      ingestion_status: "processing",
      ingestion_error: null,
      ingestion_updated_at: now()
    });

    const [readyFile, sourceDocument, storedSession] = await Promise.all([
      waitForFileReady(geminiFileName),
      getDocument(documentId),
      getSession(sessionId)
    ]);
    const metadata = {
      filename: sourceDocument?.filename || readyFile.displayName || "Uploaded document",
      displayTitle:
        sourceDocument?.displayTitle || readyFile.displayName || "Uploaded document",
      sourceType: sourceDocument?.sourceType || "product",
      language: sourceDocument?.language || "de",
      isScan: sourceDocument?.isScan === true,
      productFamily: sourceDocument?.productFamily || "",
      sourceDate: sourceDocument?.sourceDate || "",
      scope: sourceDocument?.scope || "session",
      ocrStatus: sourceDocument?.ocrStatus || ""
    };
    const session = storedSession
      ? normalizeSession(storedSession)
      : createDefaultSession();
    const fileSearchStoreName = await ensureFileSearchStore(session, sessionId);
    let fileForImport = readyFile;
    let transcriptionFileName = "";
    let operation;

    if (metadata.isScan) {
      const markdown = await transcribeScanDocument(readyFile, metadata);

      if (!markdown) {
        throw new Error("Scan transcription returned no content");
      }

      metadata.ocrStatus = "done";
      try {
        operation = await uploadTextDerivativeToFileSearchStore(
          markdown,
          `${metadata.displayTitle}.md`,
          fileSearchStoreName,
          metadata
        );
      } catch (error) {
        const textFile = await uploadTextDerivative(
          markdown,
          `${metadata.displayTitle}.md`
        );
        transcriptionFileName = textFile.name || "";
        fileForImport = textFile;
        operation = await importFileToStore(
          fileSearchStoreName,
          fileForImport.name,
          metadata
        );
      }
    } else {
      metadata.ocrStatus = metadata.ocrStatus || "not_needed";
      operation = await genAI.fileSearchStores.importFile({
        fileSearchStoreName,
        fileName: fileForImport.name,
        config: {
          customMetadata: buildCustomMetadata(metadata),
          chunkingConfig: buildChunkingConfig(metadata)
        }
      });
    }

    operation = await waitForOperationDone(operation);

    const documentName = operation.response?.documentName;

    if (!documentName) {
      throw new Error("Document indexing completed without a document name");
    }

    const documentResourceName = toDocumentResourceName(
      fileSearchStoreName,
      documentName
    );
    const document = await genAI.fileSearchStores.documents
      .get({
        name: documentResourceName
      })
      .catch(() => null);

    session.fileSearchStoreName = fileSearchStoreName;
    session.attachments = session.attachments
      .filter((attachment) => attachment.id !== documentId)
      .concat({
        id: documentId,
        name: String(document?.name || documentResourceName || "").trim(),
        displayName: String(
          metadata.filename || metadata.displayTitle || document?.displayName || "Uploaded document"
        ).trim(),
        mimeType: String(
          document?.mimeType ||
            (metadata.isScan ? "text/markdown" : fileForImport.mimeType) ||
            ""
        ).trim(),
        sizeBytes: Number(document?.sizeBytes || fileForImport.sizeBytes || 0),
        state: String(document?.state || DocumentState.STATE_ACTIVE).trim(),
        strategy: "document"
      });

    await Promise.all([
      saveSession(sessionId, session),
      updateDocument(documentId, {
        fileSearchStoreName,
        geminiDocumentName: String(document?.name || documentResourceName || "").trim(),
        ocrStatus: metadata.ocrStatus,
        transcriptionFileName: transcriptionFileName || null,
        ingestionStatus: "done",
        ingestion_status: "done",
        ingestion_error: null,
        ingestion_updated_at: now()
      }),
      updateIngestionJob(jobId, {
        status: "done",
        completedAt: now(),
        errorMessage: null
      })
    ]);

    res.json({ status: "done" });
  } catch (error) {
    console.error("[/process]", error.message || error);
    const errorMessage = truncateIngestionError(error);
    await Promise.allSettled([
      updateDocument(documentId, {
        ingestionStatus: "failed",
        ingestion_status: "failed",
        ingestion_error: errorMessage,
        ingestion_updated_at: now()
      }),
      updateIngestionJob(jobId, {
        status: "failed",
        completedAt: now(),
        errorMessage
      })
    ]);
    res.status(500).json({
      status: "failed",
      errorMessage
    });
  }
});

const PORT = Number(process.env.PORT) || 8080;

app.listen(PORT, () => {
  console.log(`Ingest worker listening on http://localhost:${PORT}`);
});
