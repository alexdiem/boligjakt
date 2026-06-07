import Anthropic from "@anthropic-ai/sdk";

function sonnetPrompt(structured, textExcerpt) {
  return `Du er en erfaren norsk bolig- og takstrådgiver. Basert på de strukturerte dataene og dokumentutdraget under, skriv en kvalitativ vurdering av boligen. Svar KUN med ren JSON (ingen forklaring, ingen markdown).

Strukturerte data:
${JSON.stringify(structured, null, 2)}

Dokumentutdrag (for kontekst om beliggenhet, standard og beskrivelse):
"""${textExcerpt}"""

Svar med nøyaktig denne JSON-strukturen:
{"vurdering":"2-4 setninger som tolker boligens helhetsinntrykk, standard og det viktigste en kjøper bør vite",
"fordeler":["kort punkt","..."],
"ulemper":["kort punkt","..."]}`;
}

function parseJson(text) {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : cleaned);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Missing API key" });

  const { structured, excerpt } = req.body;
  if (!structured) return res.status(400).json({ error: "Missing structured data" });

  const client = new Anthropic({ apiKey });

  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: sonnetPrompt(structured, excerpt || "") }],
    });
    const assessment = parseJson((msg.content || []).map((c) => c.text || "").join("").trim());
    res.json(assessment);
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ error: "invalid_key" });
    if (e.status === 429) return res.status(429).json({ error: "rate_limit" });
    console.error("Assess error:", e.message);
    res.status(500).json({ error: e.message || "Internal server error" });
  }
}
