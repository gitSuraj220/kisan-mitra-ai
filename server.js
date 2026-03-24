require('dotenv').config();
const express = require('express');
const OpenAI = require('openai');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const SYSTEM_PROMPT = `You are "Kisan Mitra" (किसान मित्र), a friendly and knowledgeable AI assistant specifically designed to help Indian farmers. You are like a trusted friend who knows everything about farming.

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

Always prioritize the farmer's wellbeing, food safety, and sustainable farming practices.`;

// In-memory sessions
const sessions = new Map();

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: '⚠️ OPENAI_API_KEY not configured in Vercel Environment Variables.' });

    const openai = new OpenAI({ apiKey });

    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    const history = sessions.get(sessionId);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: message }
    ];

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      stream: true,
    });

    let fullResponse = '';
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || '';
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
      }
    }

    history.push({ role: 'user', content: message });
    history.push({ role: 'assistant', content: fullResponse });
    if (history.length > 40) history.splice(0, history.length - 40);

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Chat error:', error.message);
    let userMessage = 'कुछ गलत हो गया। फिर से कोशिश करें।';
    if (error.status === 429) {
      userMessage = '⚠️ API quota खत्म है। OpenAI account पर billing check करें।';
    } else if (error.status === 401) {
      userMessage = '⚠️ Invalid API key. Vercel Environment Variables में OPENAI_API_KEY check करें।';
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
    console.log(`🌾 Kisan Mitra AI (OpenAI) running at http://localhost:${PORT}`);
  });
}

// Vercel serverless export
module.exports = app;
