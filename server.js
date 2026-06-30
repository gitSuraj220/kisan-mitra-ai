require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SYSTEM_PROMPT = `You are "Kisan Sutra" (किसान सूत्र), a friendly and knowledgeable AI assistant specifically designed to help Indian farmers. You are like a trusted friend who knows everything about farming.

Your expertise covers:
- Crop cultivation (खेती) - wheat, rice, sugarcane, cotton, vegetables, fruits, pulses, oilseeds
- Fertilizers (खाद/उर्वरक) - NPK, urea, DAP, organic manures, compost, vermicompost
- Pesticides & pest management (कीटनाशक) - identifying pests, diseases, safe usage
- Irrigation (सिंचाई) - drip, sprinkler, flood, water management
- Soil health (मिट्टी की सेहत) - soil testing, pH, soil types, improvement
- Seeds (बीज) - hybrid seeds, variety selection, seed treatment
- Weather & seasons (मौसम) - sowing seasons, kharif, rabi, zaid crops
- Government schemes (सरकारी योजनाएं) - PM-KISAN, Fasal Bima Yojana, MSP, subsidies
- Market prices (मंडी भाव) - selling crops, mandi rates, storage
- Modern farming techniques (आधुनिक खेती) - organic farming, precision agriculture, hydroponics

Communication style:
- Answer in the same language the farmer asks (Hindi or English or mixed Hinglish)
- Use simple, easy-to-understand language - avoid complex technical jargon
- Be warm, respectful, and encouraging
- Give practical, actionable advice with clear quantities/dosages
- Add relevant emojis occasionally to make responses friendly 🌾
- When you are given "🔎 Live web results", treat them as the most up-to-date truth and base your answer on them. Mention figures/prices with their source naturally. Never say your knowledge is outdated — use the live results instead.

Always prioritize the farmer's wellbeing, food safety, and sustainable farming practices.`;

// In-memory sessions
const sessions = new Map();

// Init OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Real-time web search via Tavily REST API (no extra dependency) ──
const FRESH_KEYWORDS = [
  // English
  'price', 'rate', 'cost', 'today', 'current', 'latest', 'now', 'this year',
  'mandi', 'msp', 'weather', 'forecast', 'rain', 'monsoon', 'scheme', 'subsidy',
  'news', 'update', 'when', '2024', '2025', '2026', '2027',
  // Hindi
  'भाव', 'दाम', 'कीमत', 'रेट', 'आज', 'अभी', 'इस साल', 'मंडी', 'मौसम',
  'बारिश', 'मानसून', 'योजना', 'सब्सिडी', 'समाचार', 'खबर', 'ताज़ा', 'ताजा',
  'कब', 'वर्तमान', 'नई', 'नया', 'एमएसपी'
];

function needsFreshData(text) {
  const lower = text.toLowerCase();
  return FRESH_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
}

async function tavilySearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: true,
        topic: 'general',
      }),
    });
    if (!resp.ok) {
      console.error('Tavily error:', resp.status, await resp.text());
      return null;
    }
    const data = await resp.json();
    let out = '';
    if (data.answer) out += `Summary: ${data.answer}\n\n`;
    if (Array.isArray(data.results)) {
      out += data.results
        .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}\nSource: ${r.url}`)
        .join('\n\n');
    }
    return out.trim() || null;
  } catch (e) {
    console.error('Tavily fetch failed:', e.message);
    return null;
  }
}

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: '⚠️ OPENAI_API_KEY not configured.' });
    }

    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    const history = sessions.get(sessionId);

    // Current date context (so the model never says "data till 2023")
    const today = new Date().toLocaleDateString('en-IN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      timeZone: 'Asia/Kolkata',
    });
    let contextBlock = `Today's date is ${today} (India). Answer with this as the current date.`;

    // Set SSE headers early
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Fetch live data when the question looks time-sensitive
    if (needsFreshData(message)) {
      res.write(`data: ${JSON.stringify({ type: 'status', content: '🔎 ताज़ा जानकारी खोज रहा हूँ...' })}\n\n`);
      const live = await tavilySearch(`${message} India farming agriculture latest 2026`);
      if (live) {
        contextBlock += `\n\n🔎 Live web results (use these as the latest facts):\n${live}`;
      }
    }

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: contextBlock },
      ...history,
      { role: 'user', content: message },
    ];

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      stream: true,
      max_tokens: 1024,
      temperature: 0.7,
    });

    let fullResponse = '';
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
      }
    }

    // Save to history
    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: fullResponse });
    // Keep last 20 exchanges (40 turns)
    if (history.length > 40) history.splice(0, history.length - 40);

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Chat error:', error.message);

    let userMessage = 'कुछ गलत हो गया। फिर से कोशिश करें।';
    if (error.status === 429) {
      userMessage = '⚠️ API quota खत्म है। OpenAI account पर billing check करें।';
    } else if (error.status === 401) {
      userMessage = '⚠️ Invalid API key. OPENAI_API_KEY check करें।';
    } else if (error.status === 404) {
      userMessage = '⚠️ Model not found. Please check your OpenAI account access.';
    }

    if (!res.headersSent) {
      res.status(500).json({ error: userMessage });
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', content: userMessage })}\n\n`);
      res.end();
    }
  }
});

app.post('/api/clear', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId) sessions.delete(sessionId);
  res.json({ success: true });
});

// Local dev
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🌾 Kisan Mitra AI (GPT-4o-mini + Tavily) running at http://localhost:${PORT}`);
    console.log(process.env.TAVILY_API_KEY ? '✅ Real-time search: ON' : '⚠️  TAVILY_API_KEY missing — real-time search OFF');
  });
}

// Vercel serverless export
module.exports = app;
