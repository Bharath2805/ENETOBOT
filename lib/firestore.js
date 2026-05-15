let _db;
let _Firestore;

function getFirestoreConstructor() {
  if (!_Firestore) {
    _Firestore = require("@google-cloud/firestore").Firestore;
  }

  return _Firestore;
}

function parseCredentials() {
  const credsJson = String(process.env.GOOGLE_CREDENTIALS_JSON || "").trim();

  if (!credsJson) {
    return undefined;
  }

  try {
    return JSON.parse(credsJson);
  } catch (_error) {
    return JSON.parse(Buffer.from(credsJson, "base64").toString("utf8"));
  }
}

function getDb() {
  if (!_db) {
    const Firestore = getFirestoreConstructor();
    const credentials = parseCredentials();
    _db = new Firestore({
      projectId: process.env.GOOGLE_PROJECT_ID || credentials?.project_id,
      credentials
    });
  }

  return _db;
}

function now() {
  const Firestore = getFirestoreConstructor();
  return Firestore.Timestamp.now();
}

function normalizeIngestionStatus(value, fallback = "done") {
  const status = String(value || "").trim();
  return ["queued", "processing", "done", "failed"].includes(status)
    ? status
    : fallback;
}

function toMillis(value) {
  if (!value) {
    return 0;
  }

  if (typeof value.toMillis === "function") {
    return value.toMillis();
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number") {
    return value;
  }

  return 0;
}

async function getSession(sessionId) {
  const snapshot = await getDb().collection("sessions").doc(sessionId).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function listSessions(limit = 20) {
  const snapshot = await getDb()
    .collection("sessions")
    .orderBy("updatedAt", "desc")
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data()
  }));
}

async function saveSession(sessionId, data) {
  const payload = {
    turns: Array.isArray(data?.turns) ? data.turns : [],
    summary: data?.summary ?? null,
    session_facts: data?.session_facts ?? data?.sessionFacts ?? null,
    fileSearchStoreName: data?.fileSearchStoreName ?? null,
    attachments: Array.isArray(data?.attachments) ? data.attachments : [],
    updatedAt: now()
  };

  await getDb().collection("sessions").doc(sessionId).set(payload, {
    merge: true
  });

  return payload;
}

async function deleteSession(sessionId) {
  await getDb().collection("sessions").doc(sessionId).delete();
}

async function createIngestionJob(jobId, documentId, sessionId) {
  const payload = {
    documentId,
    sessionId,
    status: "queued",
    errorMessage: null,
    queuedAt: now(),
    completedAt: null
  };

  await getDb().collection("ingestionJobs").doc(jobId).set(payload);
  return payload;
}

async function updateIngestionJob(jobId, fields) {
  await getDb().collection("ingestionJobs").doc(jobId).set(fields, {
    merge: true
  });
}

async function getIngestionJob(jobId) {
  const snapshot = await getDb().collection("ingestionJobs").doc(jobId).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function logWebSearchTrigger(fields) {
  await getDb().collection("web_search_triggers").add({
    session_id: fields?.session_id || "",
    message_excerpt: String(fields?.message_excerpt || "").slice(0, 200),
    trigger_type: fields?.trigger_type || "no_trigger_but_relevant",
    categories_matched: Array.isArray(fields?.categories_matched)
      ? fields.categories_matched
      : [],
    timestamp: now()
  });
}

async function findActiveIngestionJobsBySession(sessionId) {
  if (!sessionId) {
    return [];
  }

  const snapshot = await getDb()
    .collection("ingestionJobs")
    .where("sessionId", "==", sessionId)
    .get();

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data()
  })).filter((job) => ["queued", "processing"].includes(job.status));
}

async function saveDocument(documentId, metadata) {
  const ingestionStatus = normalizeIngestionStatus(
    metadata?.ingestion_status || metadata?.ingestionStatus,
    "done"
  );
  const payload = {
    filename: metadata?.filename ?? "",
    displayTitle: metadata?.displayTitle ?? "",
    sourceType: metadata?.sourceType ?? "product",
    language: metadata?.language ?? "de",
    pageCount: Number(metadata?.pageCount || 0),
    isScan: metadata?.isScan === true,
    ingestionStatus,
    ingestion_status: ingestionStatus,
    ingestion_error: metadata?.ingestion_error ?? metadata?.ingestionError ?? null,
    ingestion_updated_at:
      metadata?.ingestion_updated_at ?? metadata?.ingestionUpdatedAt ?? now(),
    fileSearchStoreName: metadata?.fileSearchStoreName ?? null,
    scope: metadata?.scope ?? null,
    productFamily: metadata?.productFamily ?? "",
    sourceDate: metadata?.sourceDate ?? "",
    chunkingProfile: metadata?.chunkingProfile ?? "",
    ocrStatus: metadata?.ocrStatus ?? "",
    geminiFileName: metadata?.geminiFileName ?? null,
    geminiDocumentName: metadata?.geminiDocumentName ?? null,
    transcriptionFileName: metadata?.transcriptionFileName ?? null,
    createdAt: metadata?.createdAt ?? now()
  };

  await getDb().collection("documents").doc(documentId).set(payload, {
    merge: true
  });

  return payload;
}

async function getDocument(documentId) {
  const snapshot = await getDb().collection("documents").doc(documentId).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function findDocumentsByFilename(filename) {
  const snapshot = await getDb()
    .collection("documents")
    .where("filename", "==", filename)
    .get();

  if (snapshot.empty) {
    return [];
  }

  return snapshot.docs
    .map((doc) => ({
      id: doc.id,
      ...doc.data()
    }))
    .sort((left, right) => {
      const leftScore =
        (left.ingestionStatus === "done" ? 1 : 0) * 10_000_000_000_000 +
        toMillis(left.createdAt);
      const rightScore =
        (right.ingestionStatus === "done" ? 1 : 0) * 10_000_000_000_000 +
        toMillis(right.createdAt);
      return rightScore - leftScore;
    });
}

async function findDocumentByFilename(filename) {
  const documents = await findDocumentsByFilename(filename);
  return documents[0] || null;
}

async function saveBegRecords(records) {
  if (!Array.isArray(records) || !records.length) {
    return;
  }

  const db = getDb();
  const savedAt = now();
  let batch = db.batch();
  let batchSize = 0;

  for (const record of records) {
    const ref = db.collection("begRecords").doc(record.id || undefined);
    batch.set(ref, {
      ...record,
      source: record.source ?? null,
      last_updated: record.last_updated ?? savedAt
    });
    batchSize += 1;

    if (batchSize === 500) {
      await batch.commit();
      batch = db.batch();
      batchSize = 0;
    }
  }

  if (batchSize) {
    await batch.commit();
  }
}

async function queryBegRecords(filters = {}) {
  let query = getDb().collection("begRecords");

  if (filters.documentId) {
    query = query.where("documentId", "==", filters.documentId);
  } else if (filters.manufacturerNormalized) {
    query = query.where(
      "manufacturerNormalized",
      "==",
      filters.manufacturerNormalized
    );
  } else if (filters.manufacturer) {
    query = query.where("manufacturer", "==", filters.manufacturer);
  } else if (filters.heatPumpType) {
    query = query.where("heatPumpType", "==", filters.heatPumpType);
  }

  if (filters.limit) {
    query = query.limit(filters.limit);
  }

  const snapshot = await query.get();
  const backfillTimestamp = now();
  const backfillWrites = [];
  let records = snapshot.docs.map((doc) => {
    const data = doc.data();

    if (!data.last_updated || !Object.prototype.hasOwnProperty.call(data, "source")) {
      backfillWrites.push(
        doc.ref.set(
          {
            ...(!data.last_updated ? { last_updated: backfillTimestamp } : {}),
            ...(!Object.prototype.hasOwnProperty.call(data, "source")
              ? { source: null }
              : {})
          },
          { merge: true }
        )
      );
    }

    return {
      id: doc.id,
      ...data,
      source: data.source ?? null,
      last_updated: data.last_updated ?? backfillTimestamp
    };
  });

  if (backfillWrites.length) {
    await Promise.allSettled(backfillWrites);
  }

  if (filters.manufacturerNormalized) {
    records = records.filter(
      (record) => record.manufacturerNormalized === filters.manufacturerNormalized
    );
  }

  if (filters.heatPumpType) {
    records = records.filter(
      (record) => record.heatPumpType === filters.heatPumpType
    );
  }

  if (typeof filters.begEligible === "boolean") {
    records = records.filter(
      (record) => record.begEligible === filters.begEligible
    );
  }

  return records;
}

async function deleteBegRecordsByDocumentId(documentId) {
  if (!documentId) {
    return 0;
  }

  const snapshot = await getDb()
    .collection("begRecords")
    .where("documentId", "==", documentId)
    .get();

  if (snapshot.empty) {
    return 0;
  }

  const db = getDb();
  let deleted = 0;
  let batch = db.batch();
  let batchSize = 0;

  for (const doc of snapshot.docs) {
    batch.delete(doc.ref);
    batchSize += 1;
    deleted += 1;

    if (batchSize === 500) {
      await batch.commit();
      batch = db.batch();
      batchSize = 0;
    }
  }

  if (batchSize) {
    await batch.commit();
  }

  return deleted;
}

async function getAppConfig() {
  const snapshot = await getDb().collection("appConfig").doc("global").get();
  return snapshot.exists ? snapshot.data() : {};
}

async function setAppConfig(fields) {
  await getDb()
    .collection("appConfig")
    .doc("global")
    .set(fields, { merge: true });
}

module.exports = {
  getDb,
  getSession,
  listSessions,
  saveSession,
  deleteSession,
  createIngestionJob,
  updateIngestionJob,
  getIngestionJob,
  logWebSearchTrigger,
  findActiveIngestionJobsBySession,
  saveDocument,
  getDocument,
  findDocumentsByFilename,
  findDocumentByFilename,
  saveBegRecords,
  queryBegRecords,
  deleteBegRecordsByDocumentId,
  getAppConfig,
  setAppConfig
};
