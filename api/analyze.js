// api/analyze.js — Groq (vision) + Apify Vivino + Apify Wine-Searcher + iDealwine
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const groqKey  = process.env.GROQ_API_KEY;
  const apifyKey = process.env.APIFY_API_KEY;
  if (!groqKey)  return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  if (!apifyKey) return res.status(500).json({ error: 'APIFY_API_KEY not configured' });

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

    // ── Lancer les 3 recherches en parallèle ────────────────────────────────
    const [vivinoResult, wineSearcherResult, idealwineResult] = await Promise.allSettled([

      // ── Vivino via Apify ──────────────────────────────────────────────────
      fetch(`https://api.apify.com/v2/acts/mrbridge~vivino-ratings-scraper/run-sync-get-dataset-items?token=${apifyKey}&timeout=25`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wineNames: [searchQuery], maxResults: 1 })
      }).then(r => r.json()),

      // ── Wine-Searcher via Apify ───────────────────────────────────────────
      fetch(`https://api.apify.com/v2/acts/abotapi~wine-searcher-scraper/run-sync-get-dataset-items?token=${apifyKey}&timeout=25`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchTerms: [searchQuery], maxResults: 1 })
      }).then(r => r.json()),

      // ── iDealwine (scraping direct) ───────────────────────────────────────
      fetch(
        `https://www.idealwine.com/fr/recherche-vins-bordeaux.jsp?search=${encodeURIComponent(searchQuery)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', 'Accept-Language': 'fr-FR,fr;q=0.9' } }
      ).then(r => r.text())
    ]);

    // ── Parser Vivino ─────────────────────────────────────────────────────
    let vivino = null;
    try {
      const vData = vivinoResult.value;
      if (Array.isArray(vData) && vData[0]) {
        vivino = {
          score: vData[0].rating || vData[0].average_rating || null,
          count: vData[0].ratingsCount || vData[0].ratings || null
        };
      }
    } catch(e) {}

    // ── Parser Wine-Searcher ──────────────────────────────────────────────
    let parker = null, suckling = null, robinson = null;
    try {
      const wsData = wineSearcherResult.value;
      if (Array.isArray(wsData) && wsData[0]) {
        const w = wsData[0];
        const scores = w.criticScores || w.scores || [];
        scores.forEach(s => {
          const name = (s.critic || s.name || '').toLowerCase();
          const score = parseInt(s.score || s.rating || 0);
          if (name.includes('parker') || name.includes('advocate')) parker = { score, note: s.note || null };
          if (name.includes('suckling')) suckling = { score, note: s.note || null };
          if (name.includes('robinson')) {
            let sc = score;
            if (sc <= 20) sc = Math.round((sc / 20) * 100);
            robinson = { score: sc, note: s.note || null };
          }
        });
      }
    } catch(e) {}

    // ── Parser iDealwine ──────────────────────────────────────────────────
    let idealwinePrice = null, idealwineUrl = null;
    try {
      const html = idealwineResult.value;
      if (typeof html === 'string' && html.includes('idealwine')) {
        // Chercher le prix moyen estimation (format: "XXX €" ou "X XXX €")
        // On évite les prix génériques en cherchant dans le contexte "prix moyen" ou "estimation"
        const priceContextMatch = html.match(/(?:prix moyen|estimation|cote)[^€]{0,100}([\d\s]+)\s*€/i)
          || html.match(/(\d{2,4}(?:\s\d{3})?)\s*€(?:\s*\/\s*(?:bouteille|bt))?/i);
        if (priceContextMatch) {
          idealwinePrice = priceContextMatch[1].replace(/\s/g, '') + '€';
        }

        // Chercher le lien vers la fiche précise du vin
        const linkMatch = html.match(/href="(\/fr\/prix-vins\/[^"]+\.jsp[^"]*)"/)
          || html.match(/href="(\/fr\/vins\/[^"]+\.html[^"]*)"/);
        if (linkMatch) idealwineUrl = 'https://www.idealwine.com' + linkMatch[1];

        // Si aucun prix trouvé dans le bon contexte, on ne met rien
      }
    } catch(e) {}

    // ── Réponse finale ────────────────────────────────────────────────────
    return res.status(200).json({
      name:        wineName,
      appellation: wine.appellation || '',
      vintage:     wineVintage,
      region:      wine.region || '',
      country:     wine.country || '',
      type:        wine.type || 'rouge',
      description: wine.description || '',
      vivino:      vivino,
      parker:      parker,
      suckling:    suckling,
      robinson:    robinson,
      price:       idealwinePrice ? { value: idealwinePrice, source: 'iDealwine', url: idealwineUrl } : null
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
