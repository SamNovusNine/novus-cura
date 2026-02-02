
import { GoogleGenAI, Type } from "@google/genai";
import { PhotoAnalysis } from "../types";

const analysisSchema = {
  type: Type.OBJECT,
  properties: {
    rating: {
      type: Type.INTEGER,
      description: "Star rating from 0 to 5. 5: Hero shot. 4: Great. 3: Good. 2: Duplicate. 1: Poor. 0: Reject.",
    },
    exposure: {
      type: Type.NUMBER,
      description: "Lightroom Exposure EV offset.",
    },
    temp: {
      type: Type.NUMBER,
      description: "White Balance Temp offset.",
    },
    highlights: { type: Type.NUMBER },
    shadows: { type: Type.NUMBER },
    whites: { type: Type.NUMBER },
    blacks: { type: Type.NUMBER },
    contrast: { type: Type.NUMBER },
    reason: {
      type: Type.STRING,
      description: "Short aesthetic reasoning.",
    },
    keywords: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Descriptive keywords for search (e.g., 'bride', 'bokeh', 'sunset').",
    },
    caption: {
      type: Type.STRING,
      description: "A short, descriptive aesthetic summary.",
    }
  },
  required: ["rating", "exposure", "temp", "highlights", "shadows", "whites", "blacks", "contrast", "reason", "keywords", "caption"],
};

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const analyzePhoto = async (base64Image: string, attempt: number = 1): Promise<PhotoAnalysis> => {
  const MAX_ATTEMPTS = 5;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: [
        {
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
            { text: "Act as a high-end commercial photo editor. Analyze this image aesthetically.\n\nSTRICT CULLING:\n- 0 STARS for out-of-focus, blurry, or rubbish shots.\n- Preserve MOOD: If moody/low-key, keep it dark. If high-key, keep it bright. Do not just balance the histogram.\n\nMETADATA:\nProvide descriptive keywords and a short caption for a semantic search engine. Return strictly valid JSON." }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: analysisSchema,
      }
    });

    const text = response.text || "";
    const result = JSON.parse(text);
    return {
      ...result,
      contrast: result.contrast ?? 0
    } as PhotoAnalysis;
  } catch (error: any) {
    const isRateLimit = error?.status === 429 || 
                       error?.message?.includes('429') || 
                       error?.message?.includes('exhausted') || 
                       error?.message?.includes('quota');

    if (isRateLimit && attempt < MAX_ATTEMPTS) {
      // Exponential backoff: 2s, 4s, 8s, 16s... plus some jitter
      const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
      console.warn(`Rate limit hit. Retrying in ${Math.round(delay)}ms (Attempt ${attempt}/${MAX_ATTEMPTS})...`);
      await wait(delay);
      return analyzePhoto(base64Image, attempt + 1);
    }

    console.error("AI Analysis Failed:", error);
    return {
      rating: 0,
      exposure: 0,
      temp: 0,
      highlights: 0,
      shadows: 0,
      whites: 0,
      blacks: 0,
      contrast: 0,
      reason: "SYSTEM_FAILURE",
      keywords: [],
      caption: "Analysis suspended due to system limits."
    };
  }
};
