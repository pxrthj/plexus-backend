javascript
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

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    const email = decodedToken.email;

    if (!email || !email.endsWith('@ves.ac.in')) return res.status(403).json({ error: 'Unauthorized Domain' });

    // Verify Admin Status
    const adminDoc = await db.collection('admins').doc(email).get();
    if (!adminDoc.exists) return res.status(403).json({ error: 'Not an Admin' });

    // Fetch and Batch Update
    const usersSnapshot = await db.collection('users').get();
    if (usersSnapshot.empty) return res.status(200).json({ success: true, message: 'No users to update' });

    const updates = usersSnapshot.docs.map(doc => ({ ref: doc.ref, data: { attendance: {}, dailyLogs: {} } }));
    const chunks = chunkArray(updates, 400); // Safe batch size

    for (const chunk of chunks) {
      const batch = db.batch();
      chunk.forEach(item => batch.update(item.ref, item.data));
      await batch.commit();
    }

    return res.status(200).json({ success: true, updated: usersSnapshot.size });

  } catch (error) {
    console.error('Reset Error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}