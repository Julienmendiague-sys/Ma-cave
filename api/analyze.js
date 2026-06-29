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
      // Recherche notes critiques + Vivino
      fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
        body: JSON.stringify({
          q: `${searchQuery} note Parker Suckling Robinson score 100 vivino`,
          gl: 'fr', hl: 'fr', num: 8
        })
      }).then(r => r.json()),

      // Recherche prix multi-sites
      fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
        body: JSON.stringify({
          q: `"${wineName}" "${wineVintage}" prix bouteille €`,
          gl: 'fr', hl: 'fr', num: 10
        })
      }).then(r => r.json())
    ]);

    // Extraire snippets des résultats notes
    const notesSnippets = (serperNotes.organic || []).map(r => r.snippet || '').join(' ');

    // Extraire note Vivino depuis les snippets
    let vivinoScore = null, vivinoCount = null;
    const allNotesText = (serperNotes.organic || []).map(r => r.title + ' ' + r.snippet).join(' ');
    const vm1 = allNotesText.match(/vivino[^0-9]*([3-5][.,][0-9])[^0-9]*5/i);
    const vm2 = allNotesText.match(/([3-5][.,][0-9])[^0-9]*5[^0-9]*vivino/i);
    const vm3 = allNotesText.match(/vivino[^0-9]*([3-5][.,][0-9])/i);
    const vm = vm1 || vm2 || vm3;
    if (vm) {
      vivinoScore = parseFloat(vm[1].replace(',','.'));
      const cm = allNotesText.match(/([0-9][0-9 ,.]*)\s*(avis|notes|ratings)/i);
      if (cm) vivinoCount = cm[1].trim();
    }

    // Extraire TOUS les prix depuis les résultats et faire une moyenne
    const priceResults = serperPrice.organic || [];
    const extractedPrices = [];
    const priceLinks = [];

    priceResults.forEach(r => {
      const text = `${r.title} ${r.snippet || ''}`;
      // Chercher prix au format "182,00 €", "182€", "182 €", "182.00€"
      const regex = /(\d{1,5}(?:[.,]\d{1,2})?)\s*€/g;
      let m;
      while ((m = regex.exec(text)) !== null) {
        const val = parseFloat(m[1].replace(',','.'));
        // Prix raisonnable pour une bouteille (8€ - 50000€)
        if (val >= 8 && val <= 50000) {
          extractedPrices.push(val);
          if (r.link && priceLinks.indexOf(r.link) === -1) priceLinks.push(r.link);
        }
      }
    });

    // Calculer la moyenne en retirant les outliers
    let avgPrice = null;
    let priceRange = null;
    if (extractedPrices.length > 0) {
      extractedPrices.sort((a,b) => a-b);
      // Si on a 4+ prix, retirer le min et max (outliers)
      let filtered = extractedPrices;
      if (extractedPrices.length >= 4) {
        filtered = extractedPrices.slice(1, extractedPrices.length - 1);
      }
      const sum = filtered.reduce((a,b) => a+b, 0);
      const avg = Math.round(sum / filtered.length);
      avgPrice = avg + '€';
      if (filtered.length > 1) {
        priceRange = Math.round(filtered[0]) + '€ - ' + Math.round(filtered[filtered.length-1]) + '€';
      }
    }

    const priceUrl = priceLinks[0] || null;
    const priceSnippets = priceResults.map(r => `${r.title}: ${r.snippet || ''}`).join(' ');

    // ── ÉTAPE 3 : Claude synthétise tout ─────────────────────────────────────
    const claudePrompt = `Tu es un expert en vins avec connaissance encyclopedique des prix du marche. Pour le vin "${searchQuery}":

INFORMATIONS TROUVEES SUR INTERNET:
${notesSnippets}
${priceSnippets}

Reponds UNIQUEMENT avec ce JSON sans markdown:
{"parker":{"score":96,"note":"court"},"suckling":{"score":95,"note":"court"},"robinson":{"score":93,"note":"court"},"vivino":4.2,"price":"150€","price_range":"130-170€","description":"1 phrase elegante"}

Regles:
- Extrait les notes des critiques depuis les infos fournies, null si pas mentionne
- Robinson sur 100 (17.5/20 = 88)
- PRIX: utilise les infos web si disponibles, sinon estime le prix marche realiste. Toujours donner un prix.
- VIVINO: donne une note realiste sur 5 basee sur la reputation et les notes critiques du vin (ex: grand cru bordeaux bien note = 4.3-4.6, vin de pays = 3.5-4.0). Toujours donner une note Vivino.`;

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
      price:       avgPrice ? {
        value:  avgPrice,
        range:  priceRange,
        source: 'Moyenne web (iDealwine, Millesima, Vinatis...)',
        url:    priceUrl || `https://www.idealwine.com/fr/cote/index.jsp?q=${encodeURIComponent(searchQuery)}`
      } : null
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
 