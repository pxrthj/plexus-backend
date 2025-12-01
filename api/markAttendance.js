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
  // Setup CORS (Allows your frontend to talk to this backend)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { uid, subject, status, date, slotIndex } = req.body;

  if (!uid || !subject || !status || !date || slotIndex === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const userRef = db.collection('users').doc(uid);
    
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error("User does not exist");

      const data = doc.data();
      const dailyLogs = data.dailyLogs || {};
      const attendance = data.attendance || {};

      // Logic: Determine Old Status
      const dayLog = dailyLogs[date] || {};
      const oldStatus = dayLog[slotIndex] || 'pending';

      if (oldStatus === status) return; 

      // Initialize Stats
      if (!attendance[subject]) attendance[subject] = { present: 0, total: 0 };
      const stats = attendance[subject];

      // Logic: Undo Old Status
      if (oldStatus === 'present') { stats.present--; stats.total--; }
      else if (oldStatus === 'absent') { stats.total--; }

      // Logic: Apply New Status
      if (status === 'present') { stats.present++; stats.total++; }
      else if (status === 'absent') { stats.total++; }

      if (stats.present < 0) stats.present = 0;
      if (stats.total < 0) stats.total = 0;

      // Update Logs
      if (!dailyLogs[date]) dailyLogs[date] = {};
      dailyLogs[date][slotIndex] = status;

      t.update(userRef, {
        [`attendance.${subject}`]: stats,
        [`dailyLogs.${date}`]: dailyLogs[date]
      });
    });

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}