import { GoogleGenAI, SchemaType, Type } from "@google/genai";
import { PhotoAnalysis } from "../types";

// Strict Schema: Forces AI to return numbers, avoiding parsing errors
const analysisSchema = {
  type: Type.OBJECT,
  properties: {
    rating: {
      type: Type.INTEGER,
      description: "Star rating from 0 to 5. 5=Hero, 4=Great, 3=Good, 0=Reject.",
    },
    exposure: {
      type: Type.NUMBER,
      description: "Exposure offset (e.g. -0.5, 0.3).",
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
  required: ["rating", "exposure", "temp", "reason", "keywords", "caption"],
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const analyzePhoto = async (base64Image: string, attempt: number = 1): Promise<PhotoAnalysis> => {
  const MAX_ATTEMPTS = 3;
  // FIXED: Use the correct stable model name
  const MODEL_NAME = 'gemini-1.5-flash';

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: "Analyze this event photo. Rating 0-5. If blurry/bad focus: 0. If sharp/emotional: 5. Return JSON." }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: analysisSchema,
      }
    });

    const text = response.text || "{}";
    const result = JSON.parse(text);

    return {
      rating: result.rating ?? 0,
      exposure: result.exposure ?? 0,
      temp: result.temp ?? 0,
      highlights: result.highlights ?? 0,
      shadows: result.shadows ?? 0,
      whites: result.whites ?? 0,
      blacks: result.blacks ?? 0,
      contrast: result.contrast ?? 0,
      reason: result.reason ?? "Processed",
      keywords: result.keywords ?? [],
      caption: result.caption ?? ""
    };

  } catch (error: any) {
    console.error("Gemini API Error:", error);
    
    // Retry logic for rate limits
    if ((error?.status === 429 || error?.message?.includes('429')) && attempt < MAX_ATTEMPTS) {
      const delay = Math.pow(2, attempt) * 1000;
      await wait(delay);
      return analyzePhoto(base64Image, attempt + 1);
    }

    // Fail gracefully
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
      caption: "Analysis failed."
    };
  }
};
