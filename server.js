import express from 'express';
import { OpenAI } from 'openai';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const clients = new Map();

wss.on('connection', (ws) => {
  console.log('📱 Appareil connecté en WebSocket natif');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (message, isBinary) => {
    // 🛠️ TRAITEMENT DES FLUX AUDIO BINAIRES
    if (isBinary) {
      if (!ws.callContext) return; // Ignore si aucune information d'appel n'est associée
      
      const { toTarget, lang } = ws.callContext;
      const targetClient = clients.get(toTarget);
      if (!targetClient) return;

      const tempFilePath = path.join('uploads', `chunk_${Date.now()}_${ws.userId}.webm`);
      
      try {
        // Écriture temporaire du buffer binaire sur le disque pour Whisper
        fs.writeFileSync(tempFilePath, message);

        // 1. Transcription Whisper
        const transcription = await openai.audio.transcriptions.create({
          file: fs.createReadStream(tempFilePath),
          model: "whisper-1",
        });

        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        if (!transcription.text.trim()) return;

        // 2. Traduction GPT-4o-mini
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: `Tu es un traducteur instantané de haute précision pour appels vidéo. Traduis le message suivant directement en code de langue '${lang}'. Ne renvoie UNIQUEMENT que la traduction finale.` },
            { role: "user", content: transcription.text }
          ],
        });

        const texteTraduit = completion.choices[0].message.content;

        // 3. Envoi de la traduction au destinataire de l'appel
        targetClient.send(JSON.stringify({
          type: 'translation',
          translated: texteTraduit,
          lang: lang
        }));

      } catch (err) {
        console.error("Erreur traitement audio WebSocket:", err);
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      }
      return;
    }

    // 🛠️ TRAITEMENT DES MESSAGES TEXTE (SIGNALEMENT & ENREGISTREMENT)
    try {
      const data = JSON.parse(message.toString());

      if (data.type === 'ping') {
        ws.isAlive = true;
        return ws.send(JSON.stringify({ type: 'pong' }));
      }

      switch (data.type) {
        case 'enregistrement':
          clients.set(data.userId, ws);
          ws.userId = data.userId;
          console.log(`🔗 Utilisateur enregistré : ${data.userId}`);
          break;

        case 'update-audio-context':
          // Mémorise à qui envoyer la traduction et dans quelle langue
          ws.callContext = { toTarget: data.toTarget, lang: data.lang };
          break;

        case 'signalement':
          const clientCible = clients.get(data.cibleId);
          if (clientCible && clientCible.readyState === ws.OPEN) {
            clientCible.send(JSON.stringify({
              type: 'signalement',
              senderId: data.senderId,
              payload: data.payload
            }));
          }
          break;
      }
    } catch (err) {
      console.error('Erreur décodage JSON :', err);
    }
  });

  ws.on('close', () => {
    if (ws.userId) {
      clients.delete(ws.userId);
      console.log(`❌ Déconnexion de : ${ws.userId}`);
    }
  });
});

// Nettoyage des connexions mortes
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      if (ws.userId) clients.delete(ws.userId);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

// Crée le dossier uploads s'il n'existe pas
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

const PORT = process.env.PORT || 8081;
app.get('/', (req, res) => res.send('🚀 Serveur Abokina opérationnel !'));
server.listen(PORT, () => console.log(`🚀 Serveur unifié sur le port : ${PORT}`));

