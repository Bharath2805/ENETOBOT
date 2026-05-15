# ENETOBOT

ENETOBOT is an Eneto-focused chat assistant built with Express, Gemini, Firestore, and Tavily.
It answers questions about Eneto products and process, can search the web for time-sensitive topics, and can use uploaded files plus structured BEG subsidy records when relevant.

## How It Works

### 1. Frontend

- `public/index.html` renders the chat UI.
- `public/chat.js` manages:
  - session creation in `sessionStorage`
  - web-search toggle state in `localStorage`
  - file upload, attachment rendering, and ingestion polling
  - SSE streaming from `/api/chat`

### 2. Main API server

- `server.js` serves the UI and exposes the main endpoints:
  - `GET /health`
  - `GET /api/attachments`
  - `POST /api/upload`
  - `GET /api/ingest/status/:jobId`
  - `DELETE /api/attachments/:attachmentId`
  - `POST /api/chat`
  - `POST /api/reset`

### 3. Session + metadata storage

- `lib/firestore.js` stores:
  - chat sessions
  - uploaded document metadata
  - ingestion jobs
  - global app config
  - structured BEG records

### 4. Prompt + retrieval logic

- `prompt.js` contains:
  - the system prompt
  - keyword-based retrieval classification
  - web-search query shaping
  - final prompt assembly
  - conversation summarization prompt

### 5. Optional ingestion worker

- `ingest-worker/index.js` handles slower background document indexing.
- This is mainly for files that should be imported into a Gemini File Search store instead of being sent directly as long-context files.

## Request Flow

When a user sends a chat message:

1. `public/chat.js` posts `message`, `sessionId`, and `forceWebSearch` to `/api/chat`.
2. `server.js` loads the session from Firestore and prunes expired media attachments.
3. If the chat is long, older turns are summarized with Gemini and compressed into `session.summary`.
4. The app decides whether the message needs:
   - plain answering
   - document retrieval
   - web search
   - BEG structured-record lookup
5. If web search is needed, Tavily is called and the results are normalized into `[WEB CONTEXT]`.
6. If BEG lookup is relevant, Firestore `begRecords` are queried and ranked.
7. The final prompt is built from:
   - system prompt
   - summary
   - recent turns
   - web context
   - document context
   - BEG context
   - current user message
8. Gemini streams the answer back over SSE.
9. The frontend renders streamed text, status updates, and source cards.
10. The final user and assistant turns are saved back to Firestore.

## Upload Flow

The upload path depends on file type:

- Images are uploaded to Gemini and attached directly as media.
- Text-friendly files such as `.txt`, `.md`, `.csv`, `.json`, `.html`, `.xml`, and `.pdf` can be kept as long-context attachments.
- Some document types are queued for background ingestion into a Gemini File Search store.

For background ingestion:

1. `/api/upload` stores a Gemini file and creates a Firestore ingestion job.
2. `processDocumentInBackground()` imports the file into the session File Search store.
3. The frontend polls `/api/ingest/status/:jobId`.
4. Once complete, the attachment becomes queryable in chat.

## Files That Matter Most

- `server.js`: main API, chat orchestration, upload handling
- `prompt.js`: system prompt and retrieval decision logic
- `public/chat.js`: streaming UI and upload UX
- `lib/firestore.js`: session, document, job, and BEG data access
- `ingest-worker/index.js`: background ingestion worker
- `scripts/ingest-global-corpus.js`: loads the global knowledge base
- `scripts/extract-beg-records.js`: extracts structured BEG eligibility data

## Environment Variables

Copy `.env.example` to `.env` and fill in the values:

- `GEMINI_API_KEY`: Gemini API key
- `TAVILY_API_KEY`: Tavily API key for live web search
- `PORT`: local port for the main chat server
- `GOOGLE_PROJECT_ID`: Firestore project id
- `GOOGLE_CREDENTIALS_JSON`: raw service-account JSON or base64-encoded JSON
- `INGEST_WORKER_URL`: remote or local ingestion worker URL
- `OCR_MODEL`: optional override for scan/OCR processing

## Run Locally

Install and start the main server:

```bash
npm install
npm start
```

Start the ingest worker separately if you want to run it locally too:

```bash
cd ingest-worker
npm install
npm start
```

## Debug Checklist

Use this order when something feels broken:

1. Check the server boots:

```bash
node server.js
curl http://localhost:3000/health
```

2. Test a simple chat request:

```bash
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  --data '{"sessionId":"debug-session","message":"What does Eneto do?"}'
```

3. Test a live-search request:

```bash
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  --data '{"sessionId":"debug-session","message":"search web latest BEG funding update for heat pumps"}'
```

4. If uploads fail, check:
   - file type is supported
   - Gemini file upload succeeds
   - Firestore credentials are valid
   - ingestion jobs move from `queued` to `done`

5. If answers look wrong, inspect:
   - retrieval classification in `prompt.js`
   - BEG lookup logic in `server.js`
   - Firestore `appConfig/global`
   - global document store metadata

## Known Behavior Notes

- General Eneto and Bosch questions often enter document-retrieval mode because the classifier is keyword-based.
- BEG structured records are intended for manufacturer- or type-anchored eligibility lookups, not general BEG news questions.
- Web search is only triggered when the message is time-sensitive or the user explicitly asks for it.

## Detailed Prompt You Can Reuse

Use this prompt when you want another AI or engineer to inspect the project clearly:

```text
Read this ENETOBOT codebase as a production debugging task.

Goals:
1. Explain the architecture in plain English.
2. Trace the full lifecycle of one message from the browser to the final streamed response.
3. Explain how uploads work, including which files are treated as media, long-context files, or indexed documents.
4. Identify bugs, confusing behavior, and weak spots in retrieval logic, especially around:
   - web search triggering
   - BEG record lookup
   - session persistence
   - file ingestion
   - SSE streaming
5. Verify the app with concrete checks:
   - server boot
   - GET /health
   - one normal /api/chat request
   - one web-search /api/chat request
   - one upload flow if possible
6. For every issue found, give:
   - root cause
   - user-visible impact
   - exact file to change
   - recommended fix
7. End with:
   - a short “how this works” summary
   - a prioritized bug list
   - the safest next changes to make

Important constraints:
- Do not guess.
- Base explanations on the actual code paths.
- Call out assumptions clearly.
- Prefer simple language over framework jargon.
```
