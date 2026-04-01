#!/usr/bin/env node
// One-time script to index the shared PDF corpus into a global Gemini File Search store.
// Run from the project root:  node scripts/ingest-global-corpus.js
// Re-running is safe — already-ingested files are skipped.

const path = require("path");
const os = require("os");

require("dotenv").config({ path: path.join(__dirname, "../.env.local") });
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const fs = require("fs");
const fsPromises = require("fs/promises");
const { createHash, randomUUID } = require("crypto");
const {
  DocumentState,
  FileState,
  GoogleGenAI,
  createPartFromUri,
  createUserContent
} = require("@google/genai");
const config = require("../config");
const firestoreLib = require("../lib/firestore");

const CORPUS_DIR =
  process.env.CORPUS_DIR ||
  "/Users/bharathkumarreddygorla/Desktop/ENETO_FILES";

const STORE_DISPLAY_NAME = "eneto-global-corpus";
const FORCE_FRESH = process.argv.includes("--fresh");

const MIME_BY_EXT = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".html": "text/html",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".tsv": "text/tab-separated-values",
  ".xlsx":
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".zip": "application/zip"
};

const genAI = new GoogleGenAI({
  apiKey:
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || ""
});
const FILE_SEARCH_OPERATION_POLL_ATTEMPTS = 300;
const FILE_SEARCH_DOCUMENT_POLL_ATTEMPTS = 300;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function buildDisplayTitle(filename) {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/_/g, " ")
    .replace(/\s*\(\d+\)\s*$/g, "")
    .trim();
}

function buildGlobalDocumentId(filename) {
  return createHash("sha1")
    .update(`global:${String(filename || "").trim().toLowerCase()}`)
    .digest("hex");
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

async function stageUploadFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const stagedPath = path.join(os.tmpdir(), `${randomUUID()}${extension}`);
  await fsPromises.copyFile(filePath, stagedPath);
  return stagedPath;
}

function inferSourceType(filename) {
  const n = filename.toLowerCase();
  if (
    n.includes("pruef_effizienznachweis") ||
    n.includes("prüf_effizienznachweis")
  ) {
    return "beg_list";
  }
  if (n.includes("playbook")) return "playbook";
  if (n.includes("onboarding")) return "onboarding";
  if (
    n.includes("faq") ||
    n.includes("infoblatt") ||
    n.includes("merkblatt")
  ) {
    return "faq";
  }
  return "product";
}

function inferLanguage(filename) {
  const n = filename.toLowerCase();
  if (
    n.includes("planung") ||
    n.includes("förder") ||
    n.includes("waerm") ||
    n.includes("wärm") ||
    n.includes("merkblatt") ||
    n.includes("infoblatt")
  ) {
    return "de";
  }
  return "en";
}

function inferIsScan(filename) {
  const normalized = String(filename || "").toLowerCase();

  return (
    normalized.includes("eneto_ac_heat_pump_playbook") ||
    normalized.includes("bosch_hvac_solutions_onboarding")
  );
}

function inferProductFamily(filename) {
  const normalized = String(filename || "").toLowerCase();

  if (normalized.includes("climate7000m")) return "Climate 7000M";
  if (normalized.includes("climate7000i")) return "Climate 7000i";
  if (normalized.includes("7000m")) return "Climate 7000M";
  if (normalized.includes("7000i")) return "Climate 7000i";
  if (normalized.includes("5000m")) return "Climate 5000M";
  if (normalized.includes("klima")) return "Klima";
  if (normalized.includes("beg")) return "BEG";
  if (normalized.includes("eneto")) return "Eneto";
  return "";
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

function buildImportMetadata(filename) {
  const sourceType = inferSourceType(filename);
  const isScan = inferIsScan(filename);

  return {
    filename,
    displayTitle: buildDisplayTitle(filename),
    sourceType,
    language: inferLanguage(filename),
    isScan,
    productFamily: inferProductFamily(filename),
    sourceDate: extractDocumentDate(filename),
    chunkingProfile: sourceType,
    ocrStatus: isScan ? "queued" : "not_needed"
  };
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
    { key: "scope", stringValue: "global" },
    { key: "sourceType", stringValue: metadata.sourceType },
    { key: "language", stringValue: metadata.language },
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
    `Transcribe the attached scanned ${metadata.sourceType} PDF into clean markdown.`,
    "Preserve headings, bullet lists, tables, product names, numbers, and page references.",
    "If text spans multiple columns, reconstruct it in normal reading order.",
    "Return markdown only."
  ].join(" ");
  const response = await genAI.models.generateContent({
    model: config.OCR_MODEL,
    contents: [
      createUserContent([
        transcriptionPrompt,
        createPartFromUri(file.uri, file.mimeType)
      ])
    ]
  });
  return String(response.text || "").trim();
}

async function uploadTextDerivative(markdown, displayName) {
  const derivativePath = path.join(os.tmpdir(), `${randomUUID()}.md`);
  await fsPromises.writeFile(derivativePath, markdown, "utf8");

  try {
    const uploadedFile = await genAI.files.upload({
      file: derivativePath,
      config: {
        displayName,
        mimeType: "text/markdown"
      }
    });

    return waitForFileActive(uploadedFile.name || "");
  } finally {
    await fsPromises.unlink(derivativePath).catch(() => {});
  }
}

async function waitForFileActive(fileName) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const file = await genAI.files.get({ name: fileName });
    if (!file.state || file.state === FileState.ACTIVE) return file;
    if (file.state === FileState.FAILED) {
      throw new Error(
        `File ${fileName} failed: ${file.error?.message || "unknown error"}`
      );
    }
    console.log(`    waiting for file to activate... (${attempt + 1}/30)`);
    await sleep(3000);
  }
  throw new Error(`File ${fileName} did not activate in time`);
}

async function waitForOperation(operation) {
  let op = operation;
  for (
    let attempt = 0;
    attempt < FILE_SEARCH_OPERATION_POLL_ATTEMPTS;
    attempt += 1
  ) {
    if (op.done) {
      if (op.error) throw new Error(op.error.message || "Operation failed");
      return op;
    }
    console.log(
      `    waiting for indexing operation... (${attempt + 1}/${FILE_SEARCH_OPERATION_POLL_ATTEMPTS})`
    );
    await sleep(3000);
    op = await genAI.operations.get({ operation: op });
  }
  if (op.done) {
    if (op.error) throw new Error(op.error.message || "Operation failed");
    return op;
  }
  throw new Error("Operation did not complete in time");
}

async function waitForDocumentActive(fileSearchStoreName, documentName) {
  const resourceName = toDocumentResourceName(
    fileSearchStoreName,
    documentName
  );

  for (
    let attempt = 0;
    attempt < FILE_SEARCH_DOCUMENT_POLL_ATTEMPTS;
    attempt += 1
  ) {
    const doc = await genAI.fileSearchStores.documents.get({
      name: resourceName
    });
    if (!doc.state || doc.state === DocumentState.STATE_ACTIVE) return doc;
    if (doc.state === DocumentState.STATE_FAILED) {
      throw new Error("Document indexing failed");
    }
    console.log(
      `    waiting for document to index... (${attempt + 1}/${FILE_SEARCH_DOCUMENT_POLL_ATTEMPTS})`
    );
    await sleep(3000);
  }
  throw new Error("Document did not finish indexing in time");
}

async function main() {
  console.log("=== Eneto Global Corpus Ingest ===\n");

  // Verify corpus directory exists
  if (!fs.existsSync(CORPUS_DIR)) {
    console.error(`Corpus directory not found: ${CORPUS_DIR}`);
    console.error(
      "Set CORPUS_DIR env var or place files at the default path."
    );
    process.exit(1);
  }

  // Load or create global store
  const appConfig = await firestoreLib.getAppConfig();
  const previousStoreName = appConfig.globalFileSearchStoreName || null;
  let storeName = previousStoreName || null;
  const existingGlobalDocuments = Array.isArray(appConfig.globalDocuments)
    ? [...appConfig.globalDocuments]
    : [];
  const globalDocuments = FORCE_FRESH ? [] : [...existingGlobalDocuments];

  if (!FORCE_FRESH && storeName && globalDocuments.length) {
    console.log(`Using existing global store: ${storeName}`);
  } else {
    console.log(
      FORCE_FRESH
        ? "Creating fresh global File Search store..."
        : "Creating new global File Search store..."
    );
    const store = await genAI.fileSearchStores.create({
      config: { displayName: STORE_DISPLAY_NAME }
    });
    storeName = store.name;
    console.log(`Created: ${storeName}`);
  }

  // List eligible files in corpus directory
  const allFiles = fs.readdirSync(CORPUS_DIR);
  const files = allFiles.filter((f) => {
    const ext = path.extname(f).toLowerCase();
    return Object.keys(MIME_BY_EXT).includes(ext);
  });

  if (!files.length) {
    console.log(`\nNo supported files found in ${CORPUS_DIR}`);
    process.exit(0);
  }

  console.log(`\nFound ${files.length} file(s) to process:`);
  files.forEach((f) => {
    const already = !FORCE_FRESH && globalDocuments.some((d) => d.filename === f);
    console.log(`  ${already ? "[skip]" : "[queue]"} ${f}`);
  });

  const results = { success: [], skipped: [], failed: [] };

  for (const filename of files) {
    // Skip already-ingested files
    if (!FORCE_FRESH && globalDocuments.some((d) => d.filename === filename)) {
      results.skipped.push(filename);
      continue;
    }

    console.log(`\nIngesting: ${filename}`);
    const filePath = path.join(CORPUS_DIR, filename);
    const mimeType = getMimeType(filename);
    const metadata = buildImportMetadata(filename);
    let uploadedFileName = "";
    let stagedFilePath = "";
    let fileForImport = null;
    let transcriptionFileName = "";

    try {
      console.log("  uploading...");
      stagedFilePath = await stageUploadFile(filePath);
      const uploadedFile = await genAI.files.upload({
        file: stagedFilePath,
        config: { displayName: filename, mimeType }
      });
      uploadedFileName = uploadedFile.name || "";
      console.log(`  uploaded: ${uploadedFileName}`);

      const activeFile = await waitForFileActive(uploadedFileName);
      fileForImport = activeFile;

      if (metadata.isScan) {
        console.log("  transcribing scan document...");
        const markdown = await transcribeScanDocument(activeFile, metadata);

        if (!markdown) {
          throw new Error("Scan transcription returned no content");
        }

        const textFile = await uploadTextDerivative(
          markdown,
          `${metadata.displayTitle}.md`
        );
        transcriptionFileName = textFile.name || "";
        fileForImport = textFile;
        metadata.ocrStatus = "done";
      }

      console.log("  importing into store...");
      let operation = await genAI.fileSearchStores.importFile({
        fileSearchStoreName: storeName,
        fileName: fileForImport.name,
        config: {
          customMetadata: buildCustomMetadata(metadata),
          chunkingConfig: buildChunkingConfig(metadata)
        }
      });
      operation = await waitForOperation(operation);

      const documentName = operation.response?.documentName;
      if (!documentName) {
        throw new Error("Import completed without a document name");
      }

      const document = await waitForDocumentActive(storeName, documentName);
      const documentResourceName = toDocumentResourceName(
        storeName,
        documentName
      );

      const docId = buildGlobalDocumentId(filename);
      await firestoreLib.saveDocument(docId, {
        ...metadata,
        scope: "global",
        geminiDocumentName: String(
          document?.name || documentResourceName || ""
        ).trim(),
        fileSearchStoreName: storeName,
        transcriptionFileName: transcriptionFileName || null,
        ingestionStatus: "done"
      });

      const docSummary = { ...metadata };
      globalDocuments.push(docSummary);

      if (!FORCE_FRESH) {
        await firestoreLib.setAppConfig({
          globalFileSearchStoreName: storeName,
          globalDocuments
        });
      }

      results.success.push(filename);
      console.log("  done.");
    } catch (err) {
      console.error(`  failed: ${err.message}`);
      results.failed.push({ filename, error: err.message });
    } finally {
      if (stagedFilePath) {
        await fsPromises.unlink(stagedFilePath).catch(() => {});
      }
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Ingested : ${results.success.length}`);
  console.log(`Skipped  : ${results.skipped.length}`);
  console.log(`Failed   : ${results.failed.length}`);

  if (results.failed.length) {
    console.log("\nFailed files:");
    results.failed.forEach((f) =>
      console.error(`  ${f.filename} — ${f.error}`)
    );
  }

  if (FORCE_FRESH && !results.failed.length) {
    await firestoreLib.setAppConfig({
      globalFileSearchStoreName: storeName,
      globalDocuments
    });

    if (previousStoreName && previousStoreName !== storeName) {
      try {
        await genAI.fileSearchStores.delete({ name: previousStoreName });
        console.log(`Deleted previous global store: ${previousStoreName}`);
      } catch (error) {
        console.error(
          `Could not delete previous store ${previousStoreName}: ${
            error.message || error
          }`
        );
      }
    }
  } else if (FORCE_FRESH && previousStoreName) {
    console.log(
      `Retained existing global store: ${previousStoreName} because the fresh ingest had failures.`
    );
  }

  console.log(`\nGlobal store: ${storeName}`);
  console.log(
    "Run /api/chat — every session now searches this store automatically."
  );

  process.exit(results.failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("\nFatal:", err.message || err);
  process.exit(1);
});
