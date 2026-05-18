import express from 'express';
import multer from 'multer';
import { OpenAI } from 'openai';
import cors from 'cors';
import fs from 'fs';
import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const app = express();

// Configuration CORS stricte pour autoriser les connexions mobiles distantes
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// 1. Création du serveur HTTP universel (Requis pour Render)
const server = createServer(app);

// 2. Fusion du WebSocketServer sur le serveur HTTP existant
const wss = new WebSocketServer({ server });

// Configuration de Stockage Temporaire pour l'audio reçu
const upload = multer({ dest: 'uploads/' });

// Initialisation du client OpenAI (La clé sera lue depuis l'interface Render)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- SECTION EXPRESS : RECEPTION ET TRADUCTION AUDIO ---
app.post('/api/translate-stream', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier audio reçu" });
    }

    const audioPath = req.file.path;
    const targetLang = req.body.targetLang || 'ja';

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
    });

    const texteOriginal = transcription.text;
    
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }

    if (!texteOriginal.trim()) {
      return res.json({ texteTraduit: "" });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Tu es un traducteur instantané de haute précision pour appels vidéo. Traduis le message suivant directement en code de langue '${targetLang}'. Ne renvoie UNIQUEMENT que la traduction finale.` },
        { role: "user", content: texteOriginal }
      ],
    });

    const texteTraduit = completion.choices.message.content;
    res.json({ texteTraduit: texteTraduit });

  } catch (error) {
    console.error("Erreur serveur traduction :", error);
    res.status(500).json({ error: "Échec du traitement audio" });
  }
});

// --- SECTION WEBSOCKET : SIGNALEMENT AVEC SÉCURITÉ GHOST CLIENTS ---
const clients = new Map();

wss.on('connection', (ws) => {
  console.log('📱 Nouvel appareil connecté au WebSocket Render');
  
  // Variable pour vérifier si la connexion avec le téléphone est toujours vivante
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.type) {
        case 'enregistrement':
          clients.set(data.userId, ws);
          ws.userId = data.userId; // Attache l'ID à la connexion
          console.log(`🔗 Utilisateur enregistré à distance : ${data.userId}`);
          break;

        case 'signalement':
          const clientCible = clients.get(data.cibleId);
          if (clientCible && clientCible.readyState === ws.OPEN) {
            clientCible.send(JSON.stringify({
              senderId: data.senderId,
              payload: data.payload
            }));
          } else {
            console.log(`⚠️ Échec signalement : Destinataire ${data.cibleId} introuvable ou déconnecté`);
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
      console.log(`❌ Déconnexion à distance de : ${ws.userId}`);
    }
  });
});

// 3. SYSTEME HEARTBEAT : Ferme les sockets morts pour éviter la saturation du serveur Render
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      if (ws.userId) clients.delete(ws.userId);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(); // Envoie un ping discret au téléphone
  });
}, 30000); // Toutes les 30 secondes

wss.on('close', () => {
  clearInterval(interval);
});

// 4. RÉGLAGE DU PORT DYNAMIQUE POUR RENDER
// Render injecte une variable d'environnement 'PORT'. S'il n'y en a pas, on prend 8081 par défaut.
const PORT = process.env.PORT || 8081;

// Affiche un message de succès sur la racine du serveur
app.get('/', (req, res) => {
  res.send('🚀 Serveur de visioconférence Abokina opérationnel et en ligne !');
});

server.listen(PORT, () => {
  console.log(`🚀 Serveur de production unifié Express + WS en ligne sur le port : ${PORT}`);
});
