// api/analyze.js — Groq (vision) + Vivino + Millesima
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
      + '{"name":"nom complet","vintage":"annee","region":"region","country":"pays","type":"rouge ou blanc ou rose ou petillant","description":"1 phrase elegante"}';

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
    if (!groqMatch) return res.status(502).json({ error: 'No JSON from Groq: ' + groqText.slice(0, 150) });
    const wine = JSON.parse(groqMatch[0]);

    const searchQuery = encodeURIComponent(`${wine.name} ${wine.vintage || ''}`);

    // ── ÉTAPE 2 : Vivino (note /5) ───────────────────────────────────────────
    let vivinoRating = null, vivinoCount = null;
    try {
      const vRes = await fetch(
        `https://www.vivino.com/api/explore/explore?q=${searchQuery}&language=fr&currency_code=EUR&per_page=1`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' } }
      );
      if (vRes.ok) {
        const vData = await vRes.json();
        const match = vData?.explore_vintage?.matches?.[0];
        if (match) {
          vivinoRating = match.vintage?.statistics?.ratings_average?.toFixed(1) || null;
          vivinoCount  = match.vintage?.statistics?.ratings_count || null;
        }
      }
    } catch (e) { /* Vivino inaccessible, on continue */ }

    // ── ÉTAPE 3 : Millesima (notes critiques) ────────────────────────────────
    let parker = null, suckling = null, robinson = null, appellation = null;
    try {
      const mRes = await fetch(
        `https://fr.millesima.com/recherche/?q=${searchQuery}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'Accept-Language': 'fr-FR' } }
      );
      if (mRes.ok) {
        const html = await mRes.text();

        // Extraire la première URL de fiche produit
        const productMatch = html.match(/href="(\/[a-z0-9-]+-(?:rouge|blanc|rose|champagne|petillant)[^"]*\.html)"/i);
        if (productMatch) {
          const productRes = await fetch(`https://fr.millesima.com${productMatch[1]}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15' }
          });
          if (productRes.ok) {
            const productHtml = await productRes.text();

            // Parker
            const parkerMatch = productHtml.match(/Robert Parker[^<]*<[^>]+>[\s]*(\d+)/i)
              || productHtml.match(/parker[^"]*"[^"]*"[^>]*>[\s]*(\d{2,3})/i)
              || productHtml.match(/(?:parker|wine advocate)[^\d]*(\d{2,3})\/100/i);
            if (parkerMatch) parker = { score: parseInt(parkerMatch[1]), note: null };

            // Suckling
            const sucklingMatch = productHtml.match(/James Suckling[^<]*<[^>]+>[\s]*(\d+)/i)
              || productHtml.match(/suckling[^\d]*(\d{2,3})\/100/i);
            if (sucklingMatch) suckling = { score: parseInt(sucklingMatch[1]), note: null };

            // Robinson
            const robinsonMatch = productHtml.match(/Jancis Robinson[^<]*<[^>]+>[\s]*(\d+)/i)
              || productHtml.match(/robinson[^\d]*(\d{2,3})\/20/i);
            if (robinsonMatch) {
              let score = parseInt(robinsonMatch[1]);
              if (score <= 20) score = Math.round((score / 20) * 100);
              robinson = { score, note: null };
            }

            // Appellation
            const appMatch = productHtml.match(/appellation[^>]*>([^<]{5,50})<\/[^>]+>/i);
            if (appMatch) appellation = appMatch[1].trim();
          }
        }
      }
    } catch (e) { /* Millesima inaccessible, on continue */ }

    // ── Réponse finale ───────────────────────────────────────────────────────
    return res.status(200).json({
      name:        wine.name,
      appellation: appellation || '',
      vintage:     wine.vintage || '',
      region:      wine.region || '',
      country:     wine.country || '',
      type:        wine.type || 'rouge',
      description: wine.description || '',
      vivino:      vivinoRating ? { score: parseFloat(vivinoRating), count: vivinoCount } : null,
      parker:      parker,
      suckling:    suckling,
      robinson:    robinson,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
