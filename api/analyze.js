// api/analyze.js — Vercel Serverless Function (Groq)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    const PROMPT = "Tu es un expert en vins avec une connaissance encyclopedique des notes des critiques. "
      + "Analyse cette etiquette et identifie precisement le vin (domaine, appellation, millesime). "
      + "Ensuite donne les notes de Robert Parker (Wine Advocate), James Suckling et Jancis Robinson. "
      + "IMPORTANT: Pour les grands vins connus (Bordeaux classes, Bourgogne, Rhone, Champagne, vins italiens, espagnols...), "
      + "tu connais leurs notes typiques - utilise tes connaissances pour donner une estimation realiste plutot que null. "
      + "Par exemple Chateau Margaux 2016 = Parker 98, Suckling 99, Robinson 95. "
      + "Petrus, Lafite, Mouton, Cheval Blanc, Haut-Brion, Ausone, Romanee-Conti, etc. ont tous des notes connues. "
      + "Pour Jancis Robinson: convertis sa note sur 20 en note sur 100 (ex: 18/20 = 90/100, 17.5/20 = 88/100). "
      + "Reponds UNIQUEMENT avec ce JSON sans markdown ni backticks: "
      + '{"name":"nom complet du vin","appellation":"appellation precise","vintage":"annee","region":"region","country":"pays",'
      + '"type":"rouge ou blanc ou rose ou petillant",'
      + '"parker":{"score":95,"note":"description courte en francais"},'
      + '"suckling":{"score":94,"note":"description courte en francais"},'
      + '"robinson":{"score":92,"note":"description courte en francais"},'
      + '"description":"description elegante du vin en 1 phrase"} '
      + "Ne mets null pour un score que si le vin est vraiment tres obscur et inconnu des critiques.";

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 1000,
        temperature: 0.1,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${imageBase64}` }
            },
            { type: 'text', text: PROMPT }
          ]
        }]
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(502).json({ error: 'Groq API error: ' + errText.slice(0, 200) });
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) return res.status(502).json({ error: 'No text in Groq response' });

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(502).json({ error: 'No JSON found: ' + text.slice(0, 150) });

    const wine = JSON.parse(match[0]);
    return res.status(200).json(wine);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
