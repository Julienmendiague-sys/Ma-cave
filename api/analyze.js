// api/analyze.js — Vercel Serverless Function (Gemini)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const PROMPT = "Tu es un expert en vins. Analyse cette etiquette de vin. "
      + "Reponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans backticks, sans texte avant ou apres. "
      + "Identifie le vin et donne les notes des critiques pour ce millesime. "
      + 'Format exact: {"name":"...","appellation":"...","vintage":"...","region":"...","country":"...","type":"rouge",'
      + '"parker":{"score":96,"note":"commentaire court"},"suckling":{"score":95,"note":"commentaire court"},'
      + '"robinson":{"score":92,"note":"commentaire court"},"description":"description courte du vin"} '
      + "Regles: type = rouge/blanc/rose/petillant. score = entier sur 100 ou null si inconnu. "
      + "Jancis Robinson note sur 20 convertie sur 100 (ex: 17.5/20 = 88/100). "
      + "Retourne UNIQUEMENT le JSON, rien d'autre.";

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: 'image/jpeg',
                  data: imageBase64
                }
              },
              { text: PROMPT }
            ]
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1000,
          }
        })
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Gemini API error: ' + errText.slice(0, 200) });
    }

    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      return res.status(502).json({ error: 'No text in Gemini response' });
    }

    // Extract JSON even if surrounded by extra text
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(502).json({ error: 'No JSON found: ' + text.slice(0, 150) });
    }

    const wine = JSON.parse(match[0]);
    return res.status(200).json(wine);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
