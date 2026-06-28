// api/analyze.js — Groq (vision) + Serper (recherche web) + Claude (synthèse)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const groqKey      = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const serperKey    = process.env.SERPER_API_KEY;

  if (!groqKey)      return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!serperKey)    return res.status(500).json({ error: 'SERPER_API_KEY not configured' });

  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Missing imageBase64' });

    // ── ÉTAPE 1 : Groq identifie le vin depuis la photo ──────────────────────
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        max_tokens: 300,
        temperature: 0.1,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            { type: 'text', text: 'Analyse cette etiquette. Reponds UNIQUEMENT avec ce JSON sans markdown: {"name":"nom complet du vin","vintage":"annee","region":"region","country":"pays","type":"rouge ou blanc ou rose ou petillant","appellation":"appellation"}' }
          ]
        }]
      })
    });

    if (!groqRes.ok) throw new Error('Groq error: ' + (await groqRes.text()).slice(0, 150));
    const groqData = await groqRes.json();
    const groqText = groqData?.choices?.[0]?.message?.content || '';
    const groqMatch = groqText.match(/\{[\s\S]*\}/);
    if (!groqMatch) throw new Error('No JSON from Groq');
    const wine = JSON.parse(groqMatch[0]);

    const wineName    = wine.name || '';
    const wineVintage = wine.vintage || '';
    const searchQuery = `${wineName} ${wineVintage}`.trim();

    // ── ÉTAPE 2 : Serper cherche les infos sur Google ─────────────────────────
    const [serperNotes, serperPrice] = await Promise.all([
      // Recherche notes critiques
      fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
        body: JSON.stringify({
          q: `${searchQuery} note Parker Suckling Robinson score 100`,
          gl: 'fr', hl: 'fr', num: 5
        })
      }).then(r => r.json()),

      // Recherche prix iDealwine
      fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
        body: JSON.stringify({
          q: `${searchQuery} prix site:idealwine.com OR site:millesima.fr OR site:wine-searcher.com`,
          gl: 'fr', hl: 'fr', num: 5
        })
      }).then(r => r.json())
    ]);

    // Extraire snippets des résultats
    const notesSnippets = (serperNotes.organic || []).map(r => r.snippet || '').join(' ');
    const priceSnippets = (serperPrice.organic || []).map(r => `${r.title}: ${r.snippet}`).join(' ');
    const priceUrl = (serperPrice.organic || []).find(r =>
      r.link && (r.link.includes('idealwine') || r.link.includes('millesima') || r.link.includes('wine-searcher'))
    )?.link || null;

    // ── ÉTAPE 3 : Claude synthétise tout ─────────────────────────────────────
    const claudePrompt = `Tu es un expert en vins. Voici des informations trouvées sur internet pour le vin "${searchQuery}":

INFORMATIONS NOTES CRITIQUES:
${notesSnippets}

INFORMATIONS PRIX:
${priceSnippets}

A partir de ces informations, reponds UNIQUEMENT avec ce JSON sans markdown:
{"parker":{"score":96,"note":"commentaire court"},"suckling":{"score":95,"note":"commentaire court"},"robinson":{"score":93,"note":"commentaire court"},"price":"45€","price_range":"40-50€","description":"description elegante du vin en 1 phrase en francais"}

Regles:
- Extrait les scores depuis les informations fournies
- Si une note n est pas mentionnee, mets null
- Pour le prix, prends le prix le plus recent trouve
- Si aucun prix trouve, mets null pour price et price_range
- Score Robinson sur 100 (convertis depuis /20 si necessaire)`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        messages: [{ role: 'user', content: claudePrompt }]
      })
    });

    if (!claudeRes.ok) throw new Error('Claude error: ' + (await claudeRes.text()).slice(0, 150));
    const claudeData = await claudeRes.json();
    const claudeText = claudeData?.content?.[0]?.text || '';
    const claudeMatch = claudeText.match(/\{[\s\S]*\}/);

    let notes = {};
    if (claudeMatch) {
      try { notes = JSON.parse(claudeMatch[0]); } catch(e) {}
    }

    // ── Réponse finale ────────────────────────────────────────────────────────
    return res.status(200).json({
      name:        wineName,
      appellation: wine.appellation || '',
      vintage:     wineVintage,
      region:      wine.region || '',
      country:     wine.country || '',
      type:        wine.type || 'rouge',
      description: notes.description || '',
      parker:      notes.parker  || null,
      suckling:    notes.suckling || null,
      robinson:    notes.robinson || null,
      price:       notes.price ? {
        value:  notes.price,
        range:  notes.price_range || null,
        source: 'iDealwine / Web',
        url:    priceUrl || `https://www.idealwine.com/fr/cote/index.jsp?q=${encodeURIComponent(searchQuery)}`
      } : null
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
 