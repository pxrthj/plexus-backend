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
  // CORS Headers
  // REPLACE 'https://your-app.web.app' with your actual deployed domain for security
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); 

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const token = authHeader.split('Bearer ')[1];
  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(token);
  } catch (error) {
    return res.status(403).json({ error: 'Invalid Token' });
  }

  const uid = decodedToken.uid; 
  const { subject, status, date, slotIndex } = req.body;

  if (!subject || !status || !date || slotIndex === undefined) {
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

      // Determine Old Status
      // FIX: Handle composite "status|subject" strings
      const dayLog = dailyLogs[date] || {};
      const rawOldStatus = dayLog[slotIndex] || 'pending';
      const oldStatus = rawOldStatus.includes('|') ? rawOldStatus.split('|')[0] : rawOldStatus;

      if (oldStatus === status) return; 

      // Initialize Stats if needed
      if (!attendance[subject]) attendance[subject] = { present: 0, total: 0 };
      const stats = attendance[subject];

      // Undo Old Status
      if (oldStatus === 'present') { stats.present--; stats.total--; }
      else if (oldStatus === 'absent') { stats.total--; }

      // Apply New Status
      if (status === 'present') { stats.present++; stats.total++; }
      else if (status === 'absent') { stats.total++; }

      if (stats.present < 0) stats.present = 0;
      if (stats.total < 0) stats.total = 0;

      // Update Logs
      if (!dailyLogs[date]) dailyLogs[date] = {};
      
      // FIX: Store Subject Name in the log (e.g., "present|Maths")
      // This makes the log immune to future timetable changes
      dailyLogs[date][slotIndex] = `${status}|${subject}`;

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