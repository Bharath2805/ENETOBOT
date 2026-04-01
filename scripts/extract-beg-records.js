#!/usr/bin/env node
const path = require("path");
const { createHash } = require("crypto");
const { spawnSync } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "../.env.local") });
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const firestoreLib = require("../lib/firestore");

const CORPUS_DIR =
  process.env.CORPUS_DIR ||
  "/Users/bharathkumarreddygorla/Desktop/ENETO_FILES";
const BEG_FILENAME =
  process.env.BEG_SOURCE_FILENAME ||
  "beg_waermepumpen_pruef_effizienznachweis (4).pdf";
const PYTHON_SCRIPT = path.join(__dirname, "extract_beg_records.py");

function buildRecordId(documentId, record) {
  return createHash("sha1")
    .update(
      [
        documentId,
        record.pageNumber,
        record.manufacturerNormalized,
        record.modelNameNormalized,
        record.heatPumpType
      ].join("|")
    )
    .digest("hex");
}

async function main() {
  const pdfPath = path.join(CORPUS_DIR, BEG_FILENAME);
  const appConfig = await firestoreLib.getAppConfig();
  const matchingDocuments = await firestoreLib.findDocumentsByFilename(
    BEG_FILENAME
  );
  const document = matchingDocuments[0] || null;

  if (!document) {
    throw new Error(
      `Could not find indexed document metadata for ${BEG_FILENAME}. Run global corpus ingest first.`
    );
  }

  const result = spawnSync("python", [PYTHON_SCRIPT, pdfPath], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 200
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "BEG parser failed");
  }

  const rawRecords = JSON.parse(result.stdout || "[]");
  const records = rawRecords.map((record) => ({
    ...record,
    documentId: document.id,
    id: buildRecordId(document.id, record)
  }));
  const begManufacturers = [...new Set(records.map((record) => record.manufacturer))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));

  const staleDocumentIds = new Set(
    matchingDocuments.map((item) => item.id).filter(Boolean)
  );

  if (appConfig?.begDocumentId) {
    staleDocumentIds.add(appConfig.begDocumentId);
  }

  for (const staleDocumentId of staleDocumentIds) {
    await firestoreLib.deleteBegRecordsByDocumentId(staleDocumentId);
  }

  await firestoreLib.saveBegRecords(records);
  await firestoreLib.setAppConfig({
    begManufacturers,
    begRecordCount: records.length,
    begDocumentId: document.id,
    begSourceFilename: BEG_FILENAME
  });

  console.log(`Saved ${records.length} BEG records for ${BEG_FILENAME}`);
  console.log(`Unique manufacturers: ${begManufacturers.length}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
