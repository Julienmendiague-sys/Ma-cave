// api/analyze.js — Groq (vision) + Claude (notes + prix)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const groqKey      = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!groqKey)      return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

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
            { type: 'text', text: 'Analyse cette etiquette. Reponds UNIQUEMENT avec ce JSON sans markdown: {"name":"nom complet","vintage":"annee","region":"region","country":"pays","type":"rouge ou blanc ou rose ou petillant","appellation":"appellation"}' }
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

    // ── ÉTAPE 2 : Claude donne les notes critiques + prix + description ───────
    const claudePrompt = "Tu es un expert en vins avec une connaissance encyclopedique. "
      + "Pour le vin suivant: " + wineName + " " + wineVintage + " (" + (wine.appellation||wine.region||'') + "), donne moi: "
      + "1. Les notes de Robert Parker (Wine Advocate), James Suckling, Jancis Robinson (convertie sur 100) "
      + "2. Le prix moyen estimé de la bouteille en euros selon le millésime "
      + "3. Une description élégante en français "
      + "Reponds UNIQUEMENT avec ce JSON sans markdown: "
      + '{"parker":{"score":96,"note":"commentaire court"},"suckling":{"score":95,"note":"commentaire court"},'
      + '"robinson":{"score":93,"note":"commentaire court"},"price":"45€","price_range":"40-50€","description":"description elegante"}  '
      + "Si tu ne connais pas une note precise, donne une estimation realiste. "
      + "Si c est un vin tres confidentiel, mets null pour les scores.";

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
        source: 'Estimation',
        url:    'https://www.idealwine.com/fr/cote/index.jsp?q=' + encodeURIComponent(wineName + ' ' + wineVintage)
      } : null
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
