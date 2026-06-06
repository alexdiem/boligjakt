import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

app.post("/api/analyze", async (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length < 15) {
    return res.status(400).json({ error: "Too little text provided" });
  }

  const prompt = `Du er en erfaren norsk bolig- og takstrådgiver. Teksten under er fra én bolig og kan inneholde BÅDE salgsoppgave OG tilstandsrapport/takst. Les begge deler, tolk innholdet, og svar KUN med ren JSON (ingen forklaring, ingen markdown).

Regler for tall: rene tall uten mellomrom, "kr" eller "m²" (4 500 000 -> 4500000; 3,5 -> 3.5). felleskostnader er per måned. bruksareal er BRA-i/BRA/P-rom i m². Bruk null der verdien mangler.

For TG2/TG3: Tilstandsgrad fra tilstandsrapporten. TG2 = avvik som kan kreve tiltak/vedlikehold. TG3 = vesentlige avvik / strakstiltak. Ta med ALLE TG2- og TG3-funn du finner. For hvert funn: tema (kort, f.eks. "Drenering", "Bad", "Tak"), beskrivelse (kort, konkret), og kostnad_lav/kostnad_hoy i kroner. Bruk takstrapportens egne kostnadsestimater der de finnes; ellers gi et grovt anslag og forklar i estimat_kommentar at det er et grovt anslag. Sett kostnad til null kun hvis du ikke har grunnlag for å anslå.

samlet_estimat = totalt anslått behov for utbedring/oppgradering (sum av de viktigste TG2/TG3-funnene), som intervall {lav, hoy}.

Svar med nøyaktig denne JSON-strukturen:
{"adresse":str,"boligtype":str,"eierform":str,"prisantydning":num,"omkostninger":num,"fellesgjeld":num,"felleskostnader":num,"bruksareal":num,"byggeaar":num,"soverom":num,"etasje":str,"energimerke":str,
"vurdering":"2-4 setninger som tolker boligens helhetsinntrykk, standard og det viktigste en kjøper bør vite",
"fordeler":["kort punkt", "..."],
"ulemper":["kort punkt", "..."],
"tg3":[{"tema":str,"beskrivelse":str,"kostnad_lav":num,"kostnad_hoy":num}],
"tg2":[{"tema":str,"beskrivelse":str,"kostnad_lav":num,"kostnad_hoy":num}],
"samlet_estimat":{"lav":num,"hoy":num},
"estimat_kommentar":"kort om hva estimatet bygger på og usikkerhet"}

Dokument(er):
"""${text.slice(0, 150000)}"""`;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });

    let responseText = (message.content || [])
      .map((c) => c.text || "")
      .join("")
      .trim();
    responseText = responseText
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    const match = responseText.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : responseText);
    res.json(parsed);
  } catch (e) {
    if (e.status === 429) {
      return res.status(429).json({ error: "rate_limit" });
    }
    console.error("Anthropic API error:", e.message);
    res.status(500).json({ error: e.message || "Internal server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
