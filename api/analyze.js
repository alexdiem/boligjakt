import Anthropic from "@anthropic-ai/sdk";

function haikuPrompt(text) {
  return `Du er en norsk boligekspert. Ekstraher strukturerte data fra dette boligdokumentet og svar KUN med ren JSON (ingen forklaring, ingen markdown).

Regler for tall: rene tall uten mellomrom, "kr" eller "m²" (4 500 000 -> 4500000; 3,5 -> 3.5). felleskostnader er per måned. bruksareal er BRA-i/BRA/P-rom i m². Bruk null der verdien mangler.

For TG2/TG3: Ta med ALLE TG2- og TG3-funn fra tilstandsrapporten. For hvert funn: tema (kort), beskrivelse (kort, konkret), kostnad_lav/kostnad_hoy i kroner. Bruk takstrapportens egne kostnadsestimater; ellers gi et grovt anslag. samlet_estimat = totalt anslått utbedringskostnad som intervall {lav, hoy}.

Svar med nøyaktig denne JSON-strukturen:
{"adresse":str,"boligtype":str,"eierform":str,"prisantydning":num,"omkostninger":num,"fellesgjeld":num,"felleskostnader":num,"bruksareal":num,"byggeaar":num,"soverom":num,"etasje":str,"energimerke":str,
"tg3":[{"tema":str,"beskrivelse":str,"kostnad_lav":num,"kostnad_hoy":num}],
"tg2":[{"tema":str,"beskrivelse":str,"kostnad_lav":num,"kostnad_hoy":num}],
"samlet_estimat":{"lav":num,"hoy":num},
"estimat_kommentar":"kort om hva estimatet bygger på og usikkerhet"}

Dokument:
"""${text.slice(0, 80000)}"""`;
}

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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Missing API key" });

  const client = new Anthropic({ apiKey });

  const { text } = req.body;
  if (!text || text.trim().length < 15) {
    return res.status(400).json({ error: "Too little text provided" });
  }

  try {
    // Haiku extracts all structured fields and TG data from the full document
    const haikusMsg = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 4000,
      messages: [{ role: "user", content: haikuPrompt(text) }],
    });
    const structured = parseJson(
      (haikusMsg.content || []).map((c) => c.text || "").join("").trim()
    );

    // Sonnet writes the qualitative assessment using structured data + brief document excerpt
    const sonnetMsg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      messages: [{ role: "user", content: sonnetPrompt(structured, text.slice(0, 15000)) }],
    });
    const assessment = parseJson(
      (sonnetMsg.content || []).map((c) => c.text || "").join("").trim()
    );

    res.json({ ...structured, ...assessment });
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ error: "invalid_key" });
    if (e.status === 429) return res.status(429).json({ error: "rate_limit" });
    console.error("Anthropic API error:", e.message);
    res.status(500).json({ error: e.message || "Internal server error" });
  }
}
