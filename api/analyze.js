// api/analyze.js — Groq (vision) + CellarTracker (prix + notes)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    // ── ÉTAPE 1 : Identifier le vin avec Groq ────────────────────────────────
    const PROMPT = "Analyse cette etiquette de vin. Reponds UNIQUEMENT avec ce JSON sans markdown: "
      + '{"name":"nom complet du domaine et du vin","vintage":"annee sur 4 chiffres","region":"region","country":"pays","type":"rouge ou blanc ou rose ou petillant","appellation":"appellation precise","description":"1 phrase elegante en francais"}';

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 500,
        temperature: 0.1,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            { type: 'text', text: PROMPT }
          ]
        }]
      })
    });

    if (!groqRes.ok) {
      const e = await groqRes.text();
      return res.status(502).json({ error: 'Groq error: ' + e.slice(0, 200) });
    }

    const groqData = await groqRes.json();
    const groqText = groqData?.choices?.[0]?.message?.content || '';
    const groqMatch = groqText.match(/\{[\s\S]*\}/);
    if (!groqMatch) return res.status(502).json({ error: 'No JSON from Groq' });
    const wine = JSON.parse(groqMatch[0]);

    const wineName    = wine.name || '';
    const wineVintage = wine.vintage || '';
    const searchQuery = `${wineName} ${wineVintage}`.trim();

    // ── ÉTAPE 2 : CellarTracker (prix + notes critiques) ─────────────────────
    let ctPrice = null, ctRating = null, ctUrl = null;
    let parker = null, suckling = null, robinson = null;

    try {
      const ctRes = await fetch(
        `https://www.cellartracker.com/wine.asp?wine=${encodeURIComponent(searchQuery)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'Accept-Language': 'fr-FR,fr;q=0.9' } }
      );

      if (ctRes.ok) {
        const html = await ctRes.text();

        // Prix moyen
        const priceMatch = html.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
        if (priceMatch) ctPrice = priceMatch[1].replace(',', '') + ' USD';

        // Note communautaire
        const ratingMatch = html.match(/Community\s+(?:Rating|Score)[^\d]*(\d+(?:\.\d)?)/i);
        if (ratingMatch) ctRating = parseFloat(ratingMatch[1]);

        // Parker
        const parkerMatch = html.match(/Parker[^\d]*(\d{2,3})/i);
        if (parkerMatch) parker = { score: parseInt(parkerMatch[1]), note: null };

        // Suckling
        const sucklingMatch = html.match(/Suckling[^\d]*(\d{2,3})/i);
        if (sucklingMatch) suckling = { score: parseInt(sucklingMatch[1]), note: null };

        // Robinson
        const robinsonMatch = html.match(/Robinson[^\d]*(\d{2,3}(?:\.\d)?)/i);
        if (robinsonMatch) {
          let score = parseFloat(robinsonMatch[1]);
          if (score <= 20) score = Math.round((score / 20) * 100);
          robinson = { score: Math.round(score), note: null };
        }

        // URL fiche
        ctUrl = `https://www.cellartracker.com/wine.asp?wine=${encodeURIComponent(searchQuery)}`;
      }
    } catch(e) { /* CellarTracker inaccessible */ }

    // ── Réponse finale ────────────────────────────────────────────────────────
    return res.status(200).json({
      name:        wineName,
      appellation: wine.appellation || '',
      vintage:     wineVintage,
      region:      wine.region || '',
      country:     wine.country || '',
      type:        wine.type || 'rouge',
      description: wine.description || '',
      vivino:      ctRating ? { score: ctRating, count: null } : null,
      parker:      parker,
      suckling:    suckling,
      robinson:    robinson,
      price:       ctPrice ? { value: ctPrice, source: 'CellarTracker', url: ctUrl } : null
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
 