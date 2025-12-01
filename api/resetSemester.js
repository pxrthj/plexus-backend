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
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // 1. VERIFY TOKEN
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    const email = decodedToken.email;

    // 2. CHECK IF ADMIN
    if (!email || !email.endsWith('@ves.ac.in')) return res.status(403).json({ error: 'Unauthorized Domain' });

    // Check your 'admins' collection to see if this email exists
    const adminDoc = await db.collection('admins').doc(email).get();
    if (!adminDoc.exists) {
        return res.status(403).json({ error: 'Not an Admin' });
    }

    // 3. EXECUTE RESET
    const usersSnapshot = await db.collection('users').get();
    const batch = db.batch();
    
    usersSnapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { attendance: {}, dailyLogs: {} });
    });

    await batch.commit();
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error(error);
    return res.status(403).json({ error: 'Action Failed' });
  }
}