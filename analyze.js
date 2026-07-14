export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ 
          parts: [{ 
            text: "הלקוח מתלבט באתר לקניית אוזניות קוונטום X7 ב-350 דולר. תמציא לו הצעה או הנחה קצרצרה ומצחיקה בשורה אחת בעברית כדי שיקנה עכשיו ולא יעזוב את העגלה." 
          }] 
        }]
      })
    });

    const data = await response.json();
    const aiText = data.candidates?.[0]?.content?.parts?.[0]?.text || "קח 15% הנחה ונסגור עניין!";
    
    return res.status(200).json({ deal: aiText });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
