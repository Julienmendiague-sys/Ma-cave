// api/analyze.js — Vercel Serverless Function
// Proxy sécurisé entre l'app et l'API Anthropic
// La clé API reste côté serveur, jamais exposée au navigateur

export default async function handler(req, res) {
  // CORS — autorise uniquement ton domaine Vercel
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight OPTIONS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Missing imageBase64' });
    }

    const PROMPT = "Tu es un expert en vins. Analyse cette etiquette de vin. "
      + "Reponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans backticks, sans texte avant ou apres. "
      + "Identifie le vin et donne les notes typiques connues des critiques pour ce millesime. "
      + "Format: "
      + '{"name":"...","appellation":"...","vintage":"...","region":"...","country":"...","type":"rouge",'
      + '"parker":{"score":96,"note":"..."},"suckling":{"score":95,"note":"..."},"robinson":{"score":92,"note":"..."},"description":"..."}'
      + " Regles: type = rouge/blanc/rose/petillant. score = entier sur 100 ou null si inconnu. "
      + "Note de Jancis Robinson convertie sur 100 (17.5/20 = 88). Retourne uniquement le JSON.";

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 }
            },
            { type: 'text', text: PROMPT }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Anthropic API error: ' + errText.slice(0, 200) });
    }

    const data = await response.json();
    const blocks = (data.content || []).filter(b => b.type === 'text');
    if (!blocks.length) {
      return res.status(502).json({ error: 'No text in response' });
    }

    const txt = blocks[blocks.length - 1].text.trim();
    const match = txt.match(/\{[\s\S]*\}/);
    if (!match) {
      return res.status(502).json({ error: 'No JSON in response: ' + txt.slice(0, 150) });
    }

    const wine = JSON.parse(match[0]);
    return res.status(200).json(wine);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
