import { GoogleGenAI, Type } from "@google/genai";
import { PhotoAnalysis } from "../types";

const analysisSchema = {
  type: Type.OBJECT,
  properties: {
    rating: { type: Type.INTEGER, description: "Rating 0-5. 5=Hero, 0=Reject." },
    exposure: { type: Type.NUMBER },
    temp: { type: Type.NUMBER },
    highlights: { type: Type.NUMBER },
    shadows: { type: Type.NUMBER },
    whites: { type: Type.NUMBER },
    blacks: { type: Type.NUMBER },
    contrast: { type: Type.NUMBER },
    reason: { type: Type.STRING },
    keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
    caption: { type: Type.STRING }
  },
  required: ["rating", "exposure", "reason", "keywords", "caption"],
};

// HELPER: Removes ```json ... ``` formatting so JSON.parse doesn't crash
const cleanJSON = (text: string): string => {
  return text.replace(/^```json\s*/, '').replace(/\s*```$/, '').trim();
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const analyzePhoto = async (base64Image: string, attempt: number = 1): Promise<PhotoAnalysis> => {
  const MAX_ATTEMPTS = 3;
  // FIXED: Use the correct public model name
  const MODEL_NAME = 'gemini-1.5-flash'; 

  try {
    // Handle Vercel vs Local environment variables
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) throw new Error("Missing API Key");

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: "Act as a pro photo editor. Rate 0-5. 0 if blurry. 5 if perfect. Return valid JSON." }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: analysisSchema,
      }
    });

    const rawText = response.text();
    if (!rawText) throw new Error("Empty response");

    // Clean the text before parsing
    const cleanedText = cleanJSON(rawText);
    const result = JSON.parse(cleanedText);

    return {
      ...result,
      contrast: result.contrast ?? 0
    } as PhotoAnalysis;

  } catch (error: any) {
    console.error("AI Error:", error);
    
    // Retry on 429 (Rate Limit) or 503 (Overload)
    const isRetryable = error?.status === 429 || error?.status === 503 || error?.message?.includes('429');

    if (isRetryable && attempt < MAX_ATTEMPTS) {
      await wait(2000 * attempt);
      return analyzePhoto(base64Image, attempt + 1);
    }

    return {
      rating: 0, exposure: 0, temp: 0, highlights: 0, shadows: 0, 
      whites: 0, blacks: 0, contrast: 0, 
      reason: "API_FAIL", keywords: [], caption: "Analysis Failed"
    };
  }
};
