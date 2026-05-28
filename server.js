require('dotenv').config();
const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));

app.post('/api/transcribe', upload.single('file'), async (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: { message: 'OPENAI_API_KEY חסר בקובץ .env' } });
    }
    if (!req.file) {
        return res.status(400).json({ error: { message: 'לא התקבל קובץ שמע' } });
    }

    try {
        const formData = new FormData();
        formData.append('file', req.file.buffer, {
            filename: 'audio.webm',
            contentType: req.file.mimetype || 'audio/webm'
        });
        formData.append('model', 'whisper-1');

        const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                ...formData.getHeaders()
            },
            body: formData
        });

        const data = await response.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: { message: e.message } });
    }
});

app.listen(PORT, () => {
    console.log(`שרת פעיל בכתובת http://localhost:${PORT}`);
});
