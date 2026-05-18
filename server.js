import express from 'express';
import multer from 'multer';
import { OpenAI } from 'openai';
import cors from 'cors';
import fs from 'fs';
import 'dotenv/config';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';

const app = express();
app.use(cors()); // Autorise votre application Ionic à communiquer avec le PC
app.use(express.json());

// Création du serveur HTTP global sur le port 8081
const server = createServer(app);

// Initialisation UNIQUE du serveur WebSocket lié au serveur HTTP principal
const wss = new WebSocketServer({ server });

// Configuration de Stockage Temporaire pour l'audio reçu
const upload = multer({ dest: 'uploads/' });

// Initialisation du client OpenAI avec votre clé API (stockée dans un fichier .env)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- SECTION EXPRESS : RECEPTION ET TRADUCTION AUDIO ---
app.post('/api/translate-stream', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Aucun fichier audio reçu" });
    }

    const audioPath = req.file.path;
    const targetLang = req.body.targetLang || 'ja'; // Langue cible (ex: japonais)

    // 1. Transcription Audio en Texte avec OpenAI Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
    });

    const texteOriginal = transcription.text;
    
    // Nettoyage du fichier temporaire sur le PC
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }

    if (!texteOriginal.trim()) {
      return res.json({ texteTraduit: "" });
    }

    // 2. Traduction du texte transcrit via GPT (Traduction Contextuelle Rapide)
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: `Tu es un traducteur instantané de haute précision pour appels vidéo. Traduis le message suivant directement en code de langue '${targetLang}'. Ne renvoie UNIQUEMENT que la traduction finale sans commentaires, sans guillemets, ni salutations.` },
        { role: "user", content: texteOriginal }
      ],
    });

    const texteTraduit = completion.choices[0].message.content;

    // 3. Envoi du résultat à l'application Ionic
    res.json({ texteTraduit: texteTraduit });

  } catch (error) {
    console.error("Erreur serveur :", error);
    res.status(500).json({ error: "Échec du traitement audio" });
  }
});

// --- SECTION WEBSOCKET : SIGNALEMENT DES APPELS VIDEO ---
// Liste pour suivre les utilisateurs connectés
const clients = new Map();

wss.on('connection', (ws) => {
  console.log('Un appareil mobile vient de se connecter au signalement !');

  ws.on('message', (message) => {
    try {
        // Force la conversion du message binaire reçu de Android en chaîne de caractères texte
        const texteBrut = message.toString();
        const data = JSON.parse(texteBrut);

        switch (data.type) {
        case 'enregistrement':
            clients.set(data.userId, ws);
            console.log(`Utilisateur connecté au signalement : ${data.userId}`);
            break;

        case 'signalement':
            const clientCible = clients.get(data.cibleId);
            if (clientCible && clientCible.readyState === ws.OPEN) {
            clientCible.send(JSON.stringify({
                senderId: data.senderId,
                payload: data.payload
            }));
            }
            break;
        }
    } catch (err) {
        console.error('Erreur lors du décodage du paquet JSON reçu :', err);
    }
    });

  ws.on('close', () => {
    // Nettoyage en cas de déconnexion
    for (let [userId, clientWs] of clients.entries()) {
      if (clientWs === ws) {
        clients.delete(userId);
        console.log(`Utilisateur déconnecté : ${userId}`);
        break;
      }
    }
  });
});

// Lancement global du serveur unifié sur le port 8081
server.listen(8081, () => {
  console.log('Backend de développement (HTTP Express + WS Signalement) actif sur le port 8081');
});
