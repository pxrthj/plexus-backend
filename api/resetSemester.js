// resetSemester.js — improved version (replace existing file)
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
  // CORS for simplicity (adjust for production)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const email = decodedToken.email;
    if (!email || !email.endsWith('@ves.ac.in')) return res.status(403).json({ error: 'Unauthorized Domain' });

    const adminDoc = await db.collection('admins').doc(email).get();
    if (!adminDoc.exists) return res.status(403).json({ error: 'Not an Admin' });

    // Load users
    const usersSnapshot = await db.collection('users').get();
    const docs = usersSnapshot.docs;
    if (!docs.length) return res.status(200).json({ success: true, message: 'No users to update' });

    // Prepare update payload
    const updateObjects = docs.map(doc => ({ ref: doc.ref, data: { attendance: {}, dailyLogs: {} } }));

    // Chunk to <= 500 requests per batch (Firestore limit)
    const chunks = chunkArray(updateObjects, 500);
    for (let i = 0; i < chunks.length; i++) {
      const batch = db.batch();
      chunks[i].forEach(item => {
        batch.update(item.ref, item.data);
      });
      await batch.commit();
      console.log(`Committed batch ${i + 1}/${chunks.length} (${chunks[i].length} updates)`);
    }

    return res.status(200).json({ success: true, batches: chunks.length, updated: docs.length });
  } catch (error) {
    console.error('resetSemester error:', error);
    // Provide helpful error text to client for debugging
    return res.status(500).json({ error: 'Action Failed', message: error.message || String(error) });
  }
}
