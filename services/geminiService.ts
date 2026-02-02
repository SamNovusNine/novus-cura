import { GoogleGenAI, SchemaType, Type } from "@google/genai";
import { PhotoAnalysis } from "../types";

// 1. Define the Schema (The "Contract" with the AI)
const analysisSchema = {
  type: Type.OBJECT,
  properties: {
    rating: {
      type: Type.INTEGER,
      description: "Star rating from 0 to 5. 5=Hero (Sharp, Emotional, Perfect Light), 4=Great, 3=Good, 2=Backup, 1=Technical Flaw, 0=Reject (Blurry/Blinking).",
    },
    exposure: {
      type: Type.NUMBER,
      description: "Lightroom Exposure EV offset (e.g. -0.5, 0.3).",
    },
    temp: { type: Type.NUMBER },
    highlights: { type: Type.NUMBER },
    shadows: { type: Type.NUMBER },
    whites: { type: Type.NUMBER },
    blacks: { type: Type.NUMBER },
    contrast: { type: Type.NUMBER },
    reason: { type: Type.STRING },
    keywords: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
    caption: { type: Type.STRING }
  },
  required: ["rating", "exposure", "reason", "keywords", "caption"],
};

// 2. Helper: Clean "Markdown" garbage from the API response
const cleanJSON = (text: string): string => {
  // Remove ```json and ``` wrappers if they exist
  let clean = text.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  // Remove generic ``` wrappers
  clean = clean.replace(/^```\s*/, '').replace(/\s*```$/, '');
  return clean.trim();
};

export const analyzePhoto = async (base64Image: string, attempt: number = 1): Promise<PhotoAnalysis> => {
  const MAX_ATTEMPTS = 3;
  // USE THE STABLE MODEL
  const MODEL_NAME = 'gemini-1.5-flash';

  try {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.API_KEY;
    
    if (!apiKey) {
        throw new Error("Missing API Key. Check Vercel Settings.");
    }

    const ai = new GoogleGenAI({ apiKey });
    
    // 3. The Prompt (optimized for "Editor Mode")
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: `
              Act as a high-end commercial photo editor. 
              1. RATE this image (0-5 stars). Be strict. 0 stars if blurry/out of focus.
              2. EDIT this image. Provide Lightroom slider values to improve it.
              3. METADATA. Provide keywords and a caption.
              
              Return ONLY valid JSON matching the schema.
            ` }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: analysisSchema,
        temperature: 0.4, // Low temperature = more consistent/strict ratings
      }
    });

    // 4. Parse & Validate
    const rawText = response.text();
    if (!rawText) throw new Error("Empty response from AI");

    const cleanedText = cleanJSON(rawText);
    const result = JSON.parse(cleanedText);

    // 5. Return Safe Object
    return {
      rating: typeof result.rating === 'number' ? result.rating : 0,
      exposure: result.exposure || 0,
      temp: result.temp || 0,
      highlights: result.highlights || 0,
      shadows: result.shadows || 0,
      whites: result.whites || 0,
      blacks: result.blacks || 0,
      contrast: result.contrast || 0,
      reason: result.reason || "Processed",
      keywords: Array.isArray(result.keywords) ? result.keywords : [],
      caption: result.caption || ""
    };

  } catch (error: any) {
    console.error("AI Analysis Failed:", error);
    
    // Retry logic for "Overloaded" (503) or "Rate Limit" (429) errors
    const isRetryable = error?.status === 503 || error?.status === 429 || error?.message?.includes('429');
    
    if (isRetryable && attempt < MAX_ATTEMPTS) {
      const delay = Math.pow(2, attempt) * 1000; // Exponential backoff (1s, 2s, 4s)
      console.log(`Retrying API (Attempt ${attempt + 1})...`);
      await new Promise(r => setTimeout(r, delay));
      return analyzePhoto(base64Image, attempt + 1);
    }

    // Return "Failed" object so the UI shows the red "API_FAIL" text
    return {
      rating: 0,
      exposure: 0,
      temp: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      contrast: 0,
      reason: "API_FAIL",
      keywords: [],
      caption: ""
    };
  }
};
