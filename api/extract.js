import Anthropic from "@anthropic-ai/sdk";
import { parseJson } from "./_utils.js";

// Allow long Haiku calls (large documents + many findings) to finish instead of
// hitting Vercel's default function timeout.
export const config = { maxDuration: 60 };

// Haiku 4.5 has a ~200K-token context window (~600k chars). We cap the input well
// under that so there's ample room for the prompt and the JSON output, while still
// covering essentially any real combined salgsoppgave + tilstandsrapport
// (typically 60–110 pages ≈ 150k–300k chars). When we do truncate, we tell the
// client so it can warn the user rather than silently dropping the tail.
const CHAR_LIMIT = 350000;

function haikuPrompt(text) {
  return `Du er en norsk boligekspert. Ekstraher strukturerte data fra dette boligdokumentet og svar KUN med ren JSON (ingen forklaring, ingen markdown).

Regler for tall: rene tall uten mellomrom, "kr" eller "m²" (4 500 000 -> 4500000; 3,5 -> 3.5). felleskostnader er per måned. bruksareal er BRA-i/BRA/P-rom i m². Bruk null der verdien mangler.

For TG2/TG3: Ta med ALLE TG2- og TG3-funn fra tilstandsrapporten. For hvert funn: tema (kort), beskrivelse (kort, konkret — maks én setning), kostnad_lav/kostnad_hoy i kroner. Bruk takstrapportens egne kostnadsestimater; ellers gi et grovt anslag. samlet_estimat = totalt anslått utbedringskostnad som intervall {lav, hoy}.

For sameie/borettslag: oppussingsfond = samlet vedlikeholdsfond/oppussingsfond/driftsfond i sameiets eller borettslagets regnskap (kr, null hvis beløpet ikke er oppgitt). vedlikeholdsplan = "Ja" hvis sameiet/borettslaget har en vedlikeholdsplan, "Nei" hvis det eksplisitt sies at det ikke finnes, null ellers. forretningsforer = navn på forretningsfører eller forvaltningsselskap (f.eks. OBOS Eiendomsforvaltning, USBL, Storbymegler), null hvis ikke nevnt.

parkering: kort beskrivelse av parkeringsmuligheter (f.eks. "Garasjeplass inkludert", "Leieplass i garasje tilgjengelig", "Beboerparkering i gate", "Ingen parkering"), null hvis ikke nevnt.

Svar med nøyaktig denne JSON-strukturen:
{"adresse":str,"boligtype":str,"eierform":str,"prisantydning":num,"omkostninger":num,"fellesgjeld":num,"felleskostnader":num,"bruksareal":num,"byggeaar":num,"soverom":num,"etasje":str,"energimerke":str,
"parkering":str,"oppussingsfond":num,"vedlikeholdsplan":str,"forretningsforer":str,
"tg3":[{"tema":str,"beskrivelse":str,"kostnad_lav":num,"kostnad_hoy":num}],
"tg2":[{"tema":str,"beskrivelse":str,"kostnad_lav":num,"kostnad_hoy":num}],
"samlet_estimat":{"lav":num,"hoy":num},
"estimat_kommentar":"kort om hva estimatet bygger på og usikkerhet"}

Dokument:
"""${text}"""`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "Missing API key" });

  const { text } = req.body;
  if (!text || text.trim().length < 15) return res.status(400).json({ error: "Too little text provided" });

  const truncated = text.length > CHAR_LIMIT;
  const doc = truncated ? text.slice(0, CHAR_LIMIT) : text;

  const client = new Anthropic({ apiKey });

  try {
    // Stream so large extractions don't hit request/gateway timeouts.
    const stream = client.messages.stream({
      model: "claude-haiku-4-5",
      max_tokens: 8000,
      messages: [{ role: "user", content: haikuPrompt(doc) }],
    });
    const msg = await stream.finalMessage();

    // If the model ran out of output budget the JSON is incomplete — report it
    // clearly instead of surfacing a confusing parse error.
    if (msg.stop_reason === "max_tokens") {
      return res.status(502).json({ error: "too_many_findings" });
    }
    const out = (msg.content || []).map((c) => c.text || "").join("").trim();
    if (!out) return res.status(502).json({ error: "empty_response" });

    const structured = parseJson(out);
    structured._truncated = truncated;
    res.json(structured);
  } catch (e) {
    if (e.status === 401) return res.status(401).json({ error: "invalid_key" });
    if (e.status === 429) return res.status(429).json({ error: "rate_limit" });
    console.error("Extract error:", e.message);
    res.status(500).json({ error: "server_error" });
  }
}
