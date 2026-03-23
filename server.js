require('dotenv').config();
const express = require('express');
const { GoogleGenAI } = require('@google/genai');
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

// In-memory sessions (resets on cold start — acceptable for serverless)
const sessions = new Map();

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: '⚠️ GEMINI_API_KEY not configured. Please set it in Vercel Environment Variables.' });

    const ai = new GoogleGenAI({ apiKey });

    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    const history = sessions.get(sessionId);

    const contents = [
      ...history,
      { role: 'user', parts: [{ text: message }] }
    ];

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const result = await ai.models.generateContentStream({
      model: 'gemini-2.0-flash',
      config: { systemInstruction: SYSTEM_PROMPT },
      contents,
    });

    let fullResponse = '';
    for await (const chunk of result) {
      const text = chunk.text;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ type: 'text', content: text })}\n\n`);
      }
    }

    history.push({ role: 'user', parts: [{ text: message }] });
    history.push({ role: 'model', parts: [{ text: fullResponse }] });
    if (history.length > 40) history.splice(0, history.length - 40);

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();

  } catch (error) {
    console.error('Chat error:', error.message);
    let userMessage = 'कुछ गलत हो गया। फिर से कोशिश करें।';
    if (error.message?.includes('429') || error.message?.includes('quota')) {
      userMessage = '⚠️ API quota खत्म है। aistudio.google.com पर अलग Google account से नई key बनाएं।';
    } else if (error.message?.includes('404')) {
      userMessage = '⚠️ Model not found. Please check your API key is from aistudio.google.com';
    } else if (error.message?.includes('API_KEY') || error.message?.includes('invalid') || error.message?.includes('400')) {
      userMessage = '⚠️ Invalid API key. Please check Vercel Environment Variables.';
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
    console.log(`🌾 Kisan Mitra AI running at http://localhost:${PORT}`);
  });
}

// Vercel serverless export
module.exports = app;
