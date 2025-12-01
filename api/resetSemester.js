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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { adminSecret } = req.body;
  
  // Security Check: Prevents random people from resetting your database
  if (adminSecret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const usersSnapshot = await db.collection('users').get();
    const batch = db.batch();
    
    usersSnapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { attendance: {}, dailyLogs: {} });
    });

    await batch.commit();
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}