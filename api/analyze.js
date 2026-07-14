export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { score, confidence } = req.body;
        const apiKey = process.env.GEMINI_API_KEY;

        // פנייה ישירה ל-API החינמי של גוגל
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `You are an e-commerce conversion optimization AI. Create a highly urgent, persuasive, custom 1-sentence micro-offer for an online shop checkout button based on the user's hesitation state. Be extremely brief (max 5-6 words). Do not include any explanations, introduction, or quotes. Just output the final button text.
                        
                        Examples of good output:
                        'Claim 15% Off Instantly!'
                        'Unlock Free Shipping Now!'
                        'Save $53 In Next 2 Mins!'
                        
                        Current Customer Metrics:
                        Hesitation Score: ${score}/100
                        Data Confidence Level: ${confidence}`
                    }]
                }]
            })
        });

        const data = await response.json();
        const aiMessage = data.candidates[0].content.parts[0].text.trim();

        return res.status(200).json({ customOffer: aiMessage });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
