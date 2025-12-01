const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    }),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  // CORS Setup
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); 

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Auth' });

  try {
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    const uid = decodedToken.uid; 
    
    // 1. DATA PREP
    const serverDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const { subject, status, date: clientDate, slotIndex } = req.body;

    if (!subject || !status || !clientDate || slotIndex === undefined) return res.status(400).json({ error: 'Missing fields' });
    if (clientDate > serverDateStr) return res.status(400).json({ error: "Time Travel: Future date." });

    // 2. CANCELLATION CHECK
    const exceptionDoc = await db.collection('daily_status').doc(clientDate).get();
    if (exceptionDoc.exists) {
        if (exceptionDoc.data()[slotIndex] === 'cancelled') {
            return res.status(403).json({ error: `⛔ Class Cancelled: Attendance blocked.` });
        }
    }

    // 3. SCHEDULE VALIDATION (No Sorting - Trusts Frontend Index)
    const dayName = new Date(clientDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });
    const scheduleSnap = await db.collection('config').doc('timetable_schedule').get();
    
    if (scheduleSnap.exists) {
        const schedule = scheduleSnap.data().schedule || {};
        const daysClasses = schedule[dayName] || [];
        
        // Use index directly to match frontend
        const targetClass = daysClasses[slotIndex];
        
        if (!targetClass) return res.status(400).json({ error: "Invalid Slot ID" });
        if (targetClass.subject !== subject) {
            return res.status(400).json({ 
                error: `Sync Error: Server expected '${targetClass.subject}' but got '${subject}'.` 
            });
        }
    }

    // 4. TRANSACTION WITH CRASH FIX
    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error("User profile missing");
      
      const data = doc.data();
      if (Date.now() - (data.lastUpdateTimestamp || 0) < 2000) throw new Error("Please wait a moment.");

      const dailyLogs = data.dailyLogs || {};
      const attendance = data.attendance || {};
      const stats = attendance[subject] || { present: 0, total: 0 };
      const oldStatus = (dailyLogs[clientDate] || {})[slotIndex] || 'pending';

      if (oldStatus === status) return;

      if (oldStatus === 'present') { stats.present--; stats.total--; }
      else if (oldStatus === 'absent') { stats.total--; }
      if (status === 'present') { stats.present++; stats.total++; }
      else if (status === 'absent') { stats.total++; }

      if (stats.present < 0) stats.present = 0;
      if (stats.total < 0) stats.total = 0;

      // Prepare nested update object
      const dayUpdate = dailyLogs[clientDate] || {};
      dayUpdate[slotIndex] = status;

      // --- CRITICAL FIX: Use set() with merge: true ---
      // This creates 'dailyLogs' and the date key if they don't exist
      // preventing the "Internal Error" crash.
      t.set(userRef, {
        attendance: { [subject]: stats },
        dailyLogs: { [clientDate]: dayUpdate },
        lastUpdateTimestamp: Date.now()
      }, { merge: true });
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Backend Error:", error);
    // Return the REAL error message for debugging
    return res.status(500).json({ error: error.message || "Unknown Server Error" });
  }
}