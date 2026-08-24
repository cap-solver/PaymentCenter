const express = require('express');
const admin = require('firebase-admin');

// جلب مفاتيح فايربيس بأمان من متغيرات بيئة ريندر (بدون ملفات)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://aboanas-copy-sync-de60e-default-rtdb.europe-west1.firebasedatabase.app"
    });
    console.log("تم الاتصال بقاعدة بيانات Firebase بنجاح!");
    
  } catch (error) {
    console.error("خطأ في قراءة FIREBASE_SERVICE_ACCOUNT:", error);
  }
} else {
  console.warn("تنبيه: متغير FIREBASE_SERVICE_ACCOUNT غير موجود في ريندر!");
}

const db = admin.database();
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

// -------- مسار تفعيل التطبيق --------
app.post('/api/activate', async (req, res) => {
  try {
    const { key, deviceId } = req.body;

    if (!key || !deviceId) {
      return res.status(400).json({ success: false, error: "الرجاء إرسال المفتاح ومعرف الجهاز" });
    }

    const keyRef = db.ref(`keys/${key}`);
    const snapshot = await keyRef.once('value');
    
    if (!snapshot.exists()) {
      return res.status(404).json({ success: false, error: "مفتاح التفعيل غير صحيح أو غير موجود" });
    }

    const keyData = snapshot.val();

    if (keyData.active !== true) {
      return res.status(403).json({ success: false, error: "هذا المفتاح غير مفعل (موقوف)" });
    }

    const phone1 = keyData.Phone1 || "";
    const phone2 = keyData.Phone2 || "";

    if (phone1 === deviceId || phone2 === deviceId) {
      return res.json({ success: true }); // الجهاز مسجل مسبقاً
    }

    if (phone1 === "" || phone1 === "null") {
      await keyRef.update({ Phone1: deviceId });
      return res.json({ success: true });
    }

    if (phone2 === "" || phone2 === "null") {
      await keyRef.update({ Phone2: deviceId });
      return res.json({ success: true });
    }

    return res.status(403).json({ success: false, error: "لقد تم استخدام هذا المفتاح على جهازين بالفعل" });

  } catch (error) {
    console.error("Error activating key:", error);
    return res.status(500).json({ success: false, error: "حدث خطأ في الخادم أثناء التفعيل" });
  }
});
// ------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
