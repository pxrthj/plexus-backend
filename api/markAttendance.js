const admin = require('firebase-admin');

// Initialize Firebase Admin if not already running
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Handle private key newlines correctly
      privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    }),
  });
}

const db = admin.firestore();

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); // SECURITY NOTE: Replace '*' with your actual frontend domain in production
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); 

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // 1. VERIFY AUTH TOKEN
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

  // 2. PREPARE DATA
  const uid = decodedToken.uid; 
  const { subject, status, date: clientDate, slotIndex } = req.body;

  if (!subject || !status || !clientDate || slotIndex === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // 3. LAYER 1: TIME VALIDATION
  // Get current Server Time in IST (India Standard Time)
  const serverDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // Format: YYYY-MM-DD
  
  // Rule: Strictly Block Future Dates
  if (clientDate > serverDateStr) {
      return res.status(400).json({ error: "Time Travel Detected: You cannot mark attendance for future dates." });
  }

  try {
    // 4. LAYER 2: SCHEDULE VALIDATION
    // Verify that the subject actually exists at this slot on this day
    
    // Get the day name (e.g., "Monday") from the client's date
    // We append 'T00:00:00' to ensure local time doesn't shift the day
    const dayName = new Date(clientDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });
    
    // Fetch Master Schedule
    const scheduleSnap = await db.collection('config').doc('timetable_schedule').get();
    
    if (scheduleSnap.exists) {
        const schedule = scheduleSnap.data().schedule || {};
        const daysClasses = schedule[dayName] || [];
        
        // Check if the slot exists
        const targetClass = daysClasses[slotIndex];
        
        if (!targetClass) {
             return res.status(400).json({ error: `Invalid Request: No class exists at index ${slotIndex} on ${dayName}.` });
        }
        
        // Check if the subject matches (Prevents marking 'Maths' during 'English' slot)
        // Note: Ensure your frontend sends the exact short-code used in your schedule config
        if (targetClass.subject !== subject) {
             return res.status(400).json({ error: `Mismatch: The class at this time is ${targetClass.subject}, not ${subject}.` });
        }
    }

    // 5. LAYER 3: TRANSACTION & RATE LIMITING
    const userRef = db.collection('users').doc(uid);
    
    await db.runTransaction(async (t) => {
      const doc = await t.get(userRef);
      if (!doc.exists) throw new Error("User profile not found");

      const data = doc.data();
      
      // --- RATE LIMIT CHECK ---
      // Prevent spamming: User must wait 2 seconds between updates
      const lastUpdate = data.lastAttendanceUpdate ? new Date(data.lastAttendanceUpdate).getTime() : 0;
      const now = Date.now();
      if (now - lastUpdate < 2000) {
          throw new Error("Please wait a moment before marking another subject.");
      }

      // --- LOGIC START ---
      const dailyLogs = data.dailyLogs || {};
      const attendance = data.attendance || {};

      const dayLog = dailyLogs[clientDate] || {};
      const oldStatus = dayLog[slotIndex] || 'pending';

      // If status hasn't changed, do nothing
      if (oldStatus === status) return; 

      if (!attendance[subject]) attendance[subject] = { present: 0, total: 0 };
      const stats = attendance[subject];

      // Revert old status
      if (oldStatus === 'present') { stats.present--; stats.total--; }
      else if (oldStatus === 'absent') { stats.total--; }

      // Apply new status
      if (status === 'present') { stats.present++; stats.total++; }
      else if (status === 'absent') { stats.total++; }

      // Safety clamps
      if (stats.present < 0) stats.present = 0;
      if (stats.total < 0) stats.total = 0;

      // Update local log object
      if (!dailyLogs[clientDate]) dailyLogs[clientDate] = {};
      dailyLogs[clientDate][slotIndex] = status;

      // --- COMMIT ---
      t.update(userRef, {
        [`attendance.${subject}`]: stats,
        [`dailyLogs.${clientDate}`]: dailyLogs[clientDate],
        lastAttendanceUpdate: new Date().toISOString() // Save timestamp for rate limiter
      });
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("Attendance Error:", error); // Log full error for Admin
    
    // Return friendly error to user
    const msg = error.message === "Please wait a moment before marking another subject." 
        ? error.message 
        : "Internal Server Error";
        
    return res.status(500).json({ error: msg });
  }
}