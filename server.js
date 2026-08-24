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

    const currentTimeMs = Date.now();
    const phone1 = keyData.Phone1 || "";
    const updates = {};
    let expireMs = 0;

    // ==========================================
    // دوال مساعدة لضبط الوقت على توقيت دمشق (UTC+3)
    // التنسيق المعتمد: YYYY-MM-DD HH:mm:ss
    // ==========================================
    const toDamascusString = (ms) => {
      const d = new Date(ms);
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Damascus', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
      }).formatToParts(d);
      const map = {};
      parts.forEach(p => map[p.type] = p.value);
      return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
    };

    const parseDamascusToMs = (str) => {
      if (!str) return 0;
      // إضافة +03:00 ليفهم السيرفر أن هذا النص مكتوب بتوقيت سوريا
      const isoStr = str.trim().replace(' ', 'T') + '+03:00';
      return Date.parse(isoStr);
    };


    // ==========================================
    // 1. أول تفعيل على الإطلاق للجهاز الأول
    // ==========================================
    if (phone1 === "" || phone1 === "null") {
      updates.Phone1 = deviceId;
      updates.activatedDateReadable = toDamascusString(currentTimeMs);
      
      if (keyData.durationDays) {
        expireMs = currentTimeMs + (keyData.durationDays * 24 * 60 * 60 * 1000);
        updates.expireDateReadable = toDamascusString(expireMs);
      }
      
      // تنظيف قاعدة البيانات من الحقول القديمة (إن وجدت)
      updates.activatedAt = null; 
      updates.expireAt = null;

      await keyRef.update(updates);
      return res.json({ success: true, expireAt: expireMs });
    }

    // ==========================================
    // 2. حساب تاريخ الانتهاء بناءً على تاريخ التفعيل المقروء 
    // (لكي يتطابق مع أي تعديل يدوي تقوم به)
    // ==========================================
    if (keyData.activatedDateReadable && keyData.durationDays) {
      const activatedMs = parseDamascusToMs(keyData.activatedDateReadable);
      
      if (!isNaN(activatedMs)) {
        expireMs = activatedMs + (keyData.durationDays * 24 * 60 * 60 * 1000);
        const expectedExpireStr = toDamascusString(expireMs);
        
        // إذا تغيرت الأيام أو تاريخ التفعيل يدوياً، نحدث تاريخ الانتهاء ليتطابق معه
        if (keyData.expireDateReadable !== expectedExpireStr) {
          updates.expireDateReadable = expectedExpireStr;
          updates.activatedAt = null; // تأكيد التنظيف
          updates.expireAt = null;    // تأكيد التنظيف
          await keyRef.update(updates);
        }
      }
    } else if (keyData.expireDateReadable) {
      // في حال لم يكن هناك أيام وكان هناك تاريخ انتهاء ثابت
      expireMs = parseDamascusToMs(keyData.expireDateReadable);
    }

    // ==========================================
    // 3. التحقق من انتهاء الصلاحية
    // ==========================================
    if (expireMs > 0 && currentTimeMs > expireMs) {
      return res.status(403).json({ success: false, error: "لقد انتهت صلاحية هذا المفتاح" });
    }

    // ==========================================
    // 4. التحقق من تطابق الأجهزة والتسجيل
    // ==========================================
    if (phone1 === deviceId || (keyData.Phone2 && keyData.Phone2 === deviceId)) {
      return res.json({ success: true, expireAt: expireMs }); 
    }

    if (keyData.hasOwnProperty('Phone2')) {
      const phone2 = keyData.Phone2 || "";
      if (phone2 === "" || phone2 === "null") {
        updates.Phone2 = deviceId;
        await keyRef.update(updates);
        return res.json({ success: true, expireAt: expireMs });
      } else {
        return res.status(403).json({ success: false, error: "لقد تم استخدام هذا المفتاح على جهازين بالفعل" });
      }
    } else {
      return res.status(403).json({ success: false, error: "المفتاح مخصص لجهاز واحد فقط" });
    }

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
