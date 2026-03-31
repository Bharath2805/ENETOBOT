module.exports = {
  GEMINI_MODEL: "gemini-2.5-flash",
  GEMINI_FILE_SEARCH_MODEL: "gemini-2.5-pro",
  MAX_HISTORY_TURNS: 10,
  SUMMARY_KEEP_TURNS: 5,
  SEARCH_TIMEOUT_MS: 7000,
  MAX_SEARCH_RESULTS: 3,
  MAX_INPUT_CHARS: 2000,
  MAX_UPLOAD_BYTES: 100 * 1024 * 1024,
  MAX_SESSION_FILES: 20,
  FILE_SEARCH_TOP_K: 8,
  UPLOAD_POLL_INTERVAL_MS: 2000,
  UPLOAD_POLL_ATTEMPTS: 60,
  UPLOAD_RATE_LIMIT_RPM: 6,
  RATE_LIMIT_RPM: 15,
  DOCS_URL: "https://docs.eneto.com",
  FALLBACK_MESSAGE:
    "I hit a temporary issue. Please try again in a moment, or check https://docs.eneto.com."
};
