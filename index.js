const express = require('express');

const app = express();
app.use(express.json());

// Store the latest payload for each channel
const channels = new Map();

// Basic health check endpoint
app.get('/', (req, res) => {
    res.send('CopySync Online HTTP Server is running!');
});

// Send payload to a channel
app.post('/api/send', (req, res) => {
    const { channelId, payload } = req.body;
    
    if (!channelId || !payload) {
        return res.status(400).json({ error: 'Missing channelId or payload' });
    }
    
    channels.set(channelId, {
        payload,
        timestamp: Date.now()
    });
    
    console.log(`Received payload for channel ${channelId} at ${new Date().toISOString()}`);
    res.json({ success: true });
});

// Poll for new payload
app.get('/api/poll/:channelId', (req, res) => {
    const { channelId } = req.params;
    const { lastId } = req.query;

    const channelData = channels.get(channelId);
    
    if (channelData && channelData.payload.id !== lastId) {
        res.json({ success: true, payload: channelData.payload });
    } else {
        res.json({ success: false, reason: 'no_new' });
    }
});

// Clean up old messages every hour to prevent memory leaks (optional, since it just keeps 1 msg per channel)
setInterval(() => {
    const now = Date.now();
    for (const [channelId, data] of channels.entries()) {
        // Remove data older than 24 hours
        if (now - data.timestamp > 24 * 60 * 60 * 1000) {
            channels.delete(channelId);
        }
    }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
