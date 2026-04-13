const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

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
    throw new Error("API 回傳內容為空");
  }

  const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error("回傳格式錯誤");
  }
  return JSON.parse(cleaned.substring(start, end + 1));
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "伺服器尚未設定 GEMINI_API_KEY",
      });
    }

    const promptText = String(req.body?.promptText || "").trim();
    const tone = String(req.body?.tone || "plain");

    if (!promptText) {
      return res.status(400).json({ error: "promptText 不可為空" });
    }

    const payload = {
      contents: [{ parts: [{ text: `Translate and Teach: "${promptText}"` }] }],
      systemInstruction: { parts: [{ text: buildSystemPrompt(tone) }] },
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
    };

    const response = await fetch(GEMINI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const raw = await response.text();
      return res.status(response.status).json({
        error: `Gemini API 錯誤: ${response.status} ${raw.slice(0, 300)}`,
      });
    }

    const result = await response.json();
    const candidate = result.candidates?.[0];
    if (!candidate) {
      return res.status(502).json({ error: "無回應，請重試" });
    }
    if (candidate.finishReason === "SAFETY") {
      return res.status(400).json({ error: "內容被安全過濾阻擋" });
    }

    const content = candidate.content?.parts?.[0]?.text || "";
    const parsed = parseModelJson(content);
    return res.status(200).json(parsed);
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : "伺服器錯誤",
    });
  }
};
