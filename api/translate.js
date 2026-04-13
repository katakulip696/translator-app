const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
  GEMINI_MODEL
)}:generateContent`;

const MAX_RETRIES = Number.parseInt(process.env.GEMINI_MAX_RETRIES || "3", 10);
const BASE_RETRY_DELAY_MS = Number.parseInt(
  process.env.GEMINI_RETRY_BASE_MS || "700",
  10
);
const MAX_RETRY_DELAY_MS = Number.parseInt(
  process.env.GEMINI_RETRY_MAX_MS || "6000",
  10
);
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

class GeminiHttpError extends Error {
  constructor(status, rawBody) {
    super(`Gemini API error ${status}`);
    this.name = "GeminiHttpError";
    this.status = status;
    this.rawBody = rawBody;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterToMs(retryAfterHeader) {
  if (!retryAfterHeader) {
    return null;
  }

  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(retryAfterHeader);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.max(0, timestamp - Date.now());
}

function getRetryDelayMs(attempt, retryAfterMs) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  }

  const exponentialBackoff = BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(exponentialBackoff + jitter, MAX_RETRY_DELAY_MS);
}

function extractGeminiMessage(rawBody) {
  if (!rawBody) {
    return "";
  }

  try {
    const parsed = JSON.parse(rawBody);
    const message = parsed?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  } catch (_) {
    // Keep fallback below if response body is not JSON.
  }

  return rawBody.replace(/\s+/g, " ").trim().slice(0, 300);
}

function buildSystemPrompt(tone) {
  const toneLabel =
    tone === "polite"
      ? "Polite/Formal (Honorifics/Jondaemal)"
      : "Casual/Plain (Banmal)";

  return `You are a Korean-Chinese translation engine and language tutor.
Current Tone Setting: ${toneLabel} (Apply this only when translating TO Korean).

Tasks:
1. Translate the input text to the target language (Korean <-> Chinese).
2. If input is Korean, translate to Chinese. If input is Chinese, translate to Korean using the requested TONE.
3. Extract 3-5 key vocabulary words from the Korean sentence.
4. For vocabulary, STRICTLY use this format: "KoreanWord[ChineseTranslation]". No English in brackets.
5. SEPARATE VOCABULARY WORDS WITH A PIPE "|" CHARACTER. DO NOT USE NEWLINES inside the vocabulary string.

Return JSON only:
{
  "original_language": "Detected Lang",
  "chinese_translation": "...",
  "korean_translation": "...",
  "vocabulary": "word1[Chinese] | word2[Chinese] | word3[Chinese]"
}`;
}

function parseModelJson(content) {
  if (!content) {
    throw new Error("API returned an empty response.");
  }

  const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("Model output is not valid JSON.");
  }

  return JSON.parse(cleaned.substring(start, end + 1));
}

async function requestGeminiWithRetry(apiKey, payload) {
  const maxAttempts = Math.max(1, MAX_RETRIES + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(GEMINI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      return response;
    }

    const rawBody = await response.text();
    const isRetryable = RETRYABLE_STATUS_CODES.has(response.status);
    if (!isRetryable || attempt === maxAttempts) {
      throw new GeminiHttpError(response.status, rawBody);
    }

    const retryAfterMs = parseRetryAfterToMs(response.headers.get("retry-after"));
    const delayMs = getRetryDelayMs(attempt, retryAfterMs);
    await sleep(delayMs);
  }

  throw new Error("Unexpected Gemini retry state.");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const requestApiKey = String(req.body?.apiKey || "").trim();
    const apiKey = requestApiKey || GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Server is missing GEMINI_API_KEY.",
      });
    }

    const promptText = String(req.body?.promptText || "").trim();
    const tone = String(req.body?.tone || "plain");

    if (!promptText) {
      return res.status(400).json({ error: "promptText is required." });
    }

    const payload = {
      contents: [{ parts: [{ text: `Translate and Teach: "${promptText}"` }] }],
      systemInstruction: { parts: [{ text: buildSystemPrompt(tone) }] },
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    };

    const response = await requestGeminiWithRetry(apiKey, payload);
    const result = await response.json();
    const candidate = result.candidates?.[0];

    if (!candidate) {
      return res.status(502).json({ error: "Gemini returned no candidates." });
    }

    if (candidate.finishReason === "SAFETY") {
      return res.status(400).json({
        error: "Request was blocked by Gemini safety filters.",
      });
    }

    const content = candidate.content?.parts?.[0]?.text || "";
    const parsed = parseModelJson(content);
    return res.status(200).json(parsed);
  } catch (error) {
    if (error instanceof GeminiHttpError) {
      if (error.status === 429) {
        return res.status(429).json({
          error:
            "Gemini API rate limit reached. Please wait a moment and try again.",
        });
      }

      if (error.status === 503) {
        return res.status(503).json({
          error:
            "Gemini is currently under high demand. We retried automatically, but it is still unavailable. Please try again in 10-30 seconds.",
        });
      }

      const providerMessage = extractGeminiMessage(error.rawBody);
      return res.status(error.status).json({
        error: `Gemini API error (${error.status}): ${providerMessage || "No details provided."}`,
      });
    }

    return res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error.",
    });
  }
};
